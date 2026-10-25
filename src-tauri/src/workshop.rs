// Zugriff auf den Steam Workshop von RimWorld – ohne API-Key.
// Suche: eingebettete SSR-Daten der Workshop-Seite. Details: öffentliche ISteamRemoteStorage-API.
// Abhängigkeiten & Screenshots: Detailseite des Mods.
use crate::util::{as_f64, js_number, js_string, num, truthy, unique, AppError, Res};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const APPID: u32 = 294100;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const API: &str = "https://api.steampowered.com/ISteamRemoteStorage";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder().timeout(Duration::from_secs(25)).build().expect("HTTP client")
});

static CACHE: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> = LazyLock::new(Default::default);

async fn cached<F>(key: String, ttl: Duration, f: F) -> Res<Value>
where
    F: Future<Output = Res<Value>>,
{
    if let Some((t, v)) = CACHE.lock().unwrap().get(&key) {
        if t.elapsed() < ttl {
            return Ok(v.clone());
        }
    }
    let v = f.await?;
    CACHE.lock().unwrap().insert(key, (Instant::now(), v.clone()));
    Ok(v)
}

async fn fetch_text(req: reqwest::RequestBuilder) -> Res<String> {
    let res = req.header("User-Agent", UA).header("Accept-Language", "en-US,en;q=0.8").send().await?;
    if !res.status().is_success() {
        return Err(AppError::trp("err.steamHttp", json!({ "status": res.status().as_u16() })));
    }
    Ok(res.text().await?)
}

async fn post_api(method: &str, params: &[(String, String)]) -> Res<Value> {
    let text = fetch_text(CLIENT.post(format!("{API}/{method}/v1/")).form(params)).await?;
    let mut v: Value = serde_json::from_str(&text)?;
    Ok(v["response"].take())
}

fn is_version_tag(t: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\d+$").unwrap());
    RE.is_match(t)
}

fn tag_names(tags: &Value) -> Vec<String> {
    tags.as_array()
        .map(|a| a.iter().map(|t| js_string(t.get("tag").filter(|x| truthy(x)).unwrap_or(t))).collect())
        .unwrap_or_default()
}

fn parse_float(s: &str) -> f64 {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[+-]?(\d+\.?\d*|\.\d+)").unwrap());
    RE.find(s).and_then(|m| m.as_str().trim().parse().ok()).unwrap_or(f64::NAN)
}

fn or_null<'a>(raw: &'a Value, key: &str) -> Option<&'a Value> {
    raw.get(key).filter(|v| !v.is_null())
}

pub fn normalize(raw: &Value, author_name: Option<&str>) -> Value {
    static SHORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]|https?://\S+").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let id = js_string(&raw["publishedfileid"]);
    let tags = tag_names(&raw["tags"]);
    let mut versions: Vec<String> = tags.iter().filter(|t| is_version_tag(t)).cloned().collect();
    versions.sort_by(|a, b| parse_float(b).partial_cmp(&parse_float(a)).unwrap_or(std::cmp::Ordering::Equal));
    let short = js_string(&raw["short_description"]);
    let short = SPACE.replace_all(&SHORT.replace_all(&short, " "), " ").trim().to_string();
    let n = |key: &str| js_number(raw.get(key).filter(|v| truthy(v)).unwrap_or(&json!(0)));
    json!({
        "id": id,
        "title": raw.get("title").filter(|v| truthy(v)).map(js_string).unwrap_or_else(|| format!("Workshop-Item {id}")),
        "shortDescription": short,
        "description": or_null(raw, "file_description").or_else(|| or_null(raw, "description")).cloned().unwrap_or(json!("")),
        "preview": raw.get("preview_url").filter(|v| truthy(v)).cloned().unwrap_or(json!("")),
        "creatorId": js_string(raw.get("creator").filter(|v| truthy(v)).unwrap_or(&json!(""))),
        "author": author_name.unwrap_or_default(),
        "subscriptions": n("subscriptions"),
        "lifetimeSubscriptions": n("lifetime_subscriptions"),
        "favorited": n("favorited"),
        "views": n("views"),
        "stars": js_number(or_null(raw, "star_rating").unwrap_or(&json!(-1))),
        "votes": n("total_votes"),
        "size": n("file_size"),
        "timeCreated": n("time_created"),
        "timeUpdated": n("time_updated"),
        "tags": tags.iter().filter(|t| !is_version_tag(t)).collect::<Vec<_>>(),
        "versions": versions,
        "isCollection": raw.get("file_type") == Some(&json!(2)),
        "ok": raw.get("result").is_none() || raw.get("result") == Some(&json!(1))
    })
}

fn json_or_string(v: &Value) -> Option<Value> {
    match v {
        Value::String(s) => serde_json::from_str(s).ok(),
        Value::Null => None,
        other => Some(other.clone()),
    }
}

fn parse_ssr(html: &str) -> Option<Vec<Value>> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"<script type="application/json" id="valve-ssr-data"[^>]*>([\s\S]*?)</script>"#).unwrap());
    let m = RE.captures(html)?;
    let data: Value = serde_json::from_str(&m[1]).ok()?;
    let rc = json_or_string(&data["renderContext"]);
    let qd = rc.as_ref().and_then(|rc| json_or_string(&rc["queryData"]));
    Some(qd.and_then(|q| q["queries"].as_array().cloned()).unwrap_or_default())
}

fn sort_key(sort: &str) -> &str {
    match sort {
        "trend" => "trend",
        "popular" => "totaluniquesubscribers",
        "recent" => "mostrecent",
        "updated" => "lastupdated",
        "relevance" => "textsearch",
        other => other,
    }
}

// params: { query, sort, page, days, version, tags[] }
pub async fn browse(params: &Value) -> Res<Value> {
    let str_or = |key: &str, def: &str| params.get(key).filter(|v| !v.is_null()).map(js_string).unwrap_or_else(|| def.into());
    let query = str_or("query", "");
    let sort = str_or("sort", "trend");
    let page = params.get("page").filter(|v| !v.is_null()).cloned().unwrap_or(json!(1));
    let days = str_or("days", "7");
    let version = str_or("version", "");
    let tags: Vec<String> = params["tags"].as_array().map(|a| a.iter().map(js_string).collect()).unwrap_or_default();

    let mut url = reqwest::Url::parse("https://steamcommunity.com/workshop/browse/").unwrap();
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("appid", &APPID.to_string());
        q.append_pair("section", "readytouseitems");
        q.append_pair("browsesort", sort_key(&sort));
        q.append_pair("actualsort", sort_key(&sort));
        if !query.is_empty() {
            q.append_pair("searchtext", &query);
        }
        if sort == "trend" {
            q.append_pair("days", &days);
        }
        q.append_pair("p", &js_string(&page));
        let mut all = tags.clone();
        if !version.is_empty() {
            all.push(version.clone());
        }
        for t in &all {
            q.append_pair("requiredtags[]", t);
        }
    }

    let key = url.to_string();
    cached(key.clone(), Duration::from_secs(5 * 60), async move {
        let html = fetch_text(CLIENT.get(url)).await?;
        let queries = parse_ssr(&html).unwrap_or_default();
        let q = queries.iter().find(|x| x["queryKey"][0] == "workshop_browse");
        if let Some(d) = q.map(|q| &q["state"]["data"]).filter(|d| truthy(d)) {
            let mut names: HashMap<String, String> = HashMap::new();
            for x in &queries {
                if x["queryKey"][0] == "PlayerLinkDetails" && truthy(&x["state"]["data"]["public_data"]) {
                    names.insert(js_string(&x["queryKey"][1]), js_string(&x["state"]["data"]["public_data"]["persona_name"]));
                }
            }
            for p in d["creator_player_link_details"].as_array().into_iter().flatten() {
                if truthy(&p["public_data"]) {
                    names.insert(js_string(&p["public_data"]["steamid"]), js_string(&p["public_data"]["persona_name"]));
                }
            }
            let items: Vec<Value> = d["results"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| normalize(r, names.get(&js_string(&r["creator"])).map(String::as_str)))
                .collect();
            let or = |v: &Value, def: Value| if truthy(v) { v.clone() } else { def };
            return Ok(json!({
                "items": items,
                "total": or(&d["total_count"], json!(0)),
                "totalPages": or(&d["total_pages"], json!(1)),
                "page": page
            }));
        }
        // Fallback für das alte Seitenlayout: IDs aus dem HTML holen und Details nachladen.
        static IDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"data-publishedfileid="(\d+)""#).unwrap());
        let ids = unique(IDS.captures_iter(&html).map(|c| c[1].to_string()));
        let items = details(&ids).await?;
        let len = items.len();
        Ok(json!({
            "items": items,
            "total": len,
            "totalPages": num(as_f64(&page) + if len >= 30 { 1.0 } else { 0.0 }),
            "page": page
        }))
    })
    .await
}

// Details für viele IDs (max. 100 pro Anfrage).
pub async fn details(ids: &[String]) -> Res<Vec<Value>> {
    let list = unique(ids.iter().cloned()).into_iter().filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()));
    let list: Vec<String> = list.collect();
    let mut out = Vec::new();
    for chunk in list.chunks(100) {
        let key = format!("details:{}", chunk.join(","));
        let part = cached(key, Duration::from_secs(2 * 60), async {
            let mut params = vec![("itemcount".to_string(), chunk.len().to_string())];
            for (n, id) in chunk.iter().enumerate() {
                params.push((format!("publishedfileids[{n}]"), id.clone()));
            }
            let res = post_api("GetPublishedFileDetails", &params).await?;
            let items: Vec<Value> = res["publishedfiledetails"].as_array().into_iter().flatten().map(|r| normalize(r, None)).collect();
            Ok(Value::Array(items))
        })
        .await?;
        out.extend(part.as_array().cloned().unwrap_or_default());
    }
    Ok(out)
}

pub async fn details_value(ids: &[String]) -> Res<Value> {
    Ok(Value::Array(details(ids).await?))
}

fn decode_html(s: &str) -> String {
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    static APOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#0?39;").unwrap());
    let s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    SPACE.replace_all(&APOS.replace_all(&s, "'"), " ").trim().to_string()
}

// Liest von der Detailseite: benötigte Items, Screenshots, Autor, benötigte DLCs.
pub async fn page_info(id: &str) -> Res<Value> {
    let url = format!("https://steamcommunity.com/sharedfiles/filedetails/?id={id}");
    cached(format!("page:{id}"), Duration::from_secs(10 * 60), async move {
        static BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"id="RequiredItems">([\s\S]*?)</div>\s*</div>"#).unwrap());
        static ITEM: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"filedetails/\?id=(\d+)"[\s\S]*?class="requiredItem">([\s\S]*?)</div>"#).unwrap());
        static DLC_BLOCK: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"id="RequiredAppItems">([\s\S]*?)</div>\s*</div>"#).unwrap());
        static DLC_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"class="requiredItem">([\s\S]*?)</div>"#).unwrap());
        static SHOT: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"'url':\s*'(https://images\.steamusercontent\.com/ugc/[^']+)'").unwrap());
        static AUTHOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"class="friendBlockContent">\s*([^<]+?)\s*<br"#).unwrap());

        let html = fetch_text(CLIENT.get(url)).await?;
        let mut required = Vec::new();
        if let Some(block) = BLOCK.captures(&html) {
            for m in ITEM.captures_iter(&block[1]) {
                required.push(json!({ "id": &m[1], "name": decode_html(&m[2]) }));
            }
        }
        let mut required_dlc = Vec::new();
        if let Some(block) = DLC_BLOCK.captures(&html) {
            for m in DLC_ITEM.captures_iter(&block[1]) {
                required_dlc.push(decode_html(&m[1]));
            }
        }
        let screenshots = unique(SHOT.captures_iter(&html).map(|m| m[1].split('?').next().unwrap_or_default().to_string()));
        let author = AUTHOR.captures(&html).map(|m| decode_html(&m[1])).unwrap_or_default();
        Ok(json!({ "required": required, "requiredDlc": required_dlc, "screenshots": screenshots, "author": author }))
    })
    .await
}

type BoxFut<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

struct DepWalk<'a> {
    visited: HashSet<String>,
    order: Vec<String>,
    names: Map<String, Value>,
    is_installed: &'a (dyn Fn(&str) -> bool + Sync),
}

fn visit<'a>(w: &'a mut DepWalk<'_>, id: String, depth: u32) -> BoxFut<'a> {
    Box::pin(async move {
        if w.visited.contains(&id) || depth > 8 {
            return;
        }
        w.visited.insert(id.clone());
        // Detailseite nicht erreichbar – ohne Abhängigkeiten weiter.
        let info = page_info(&id).await.unwrap_or_else(|_| json!({ "required": [] }));
        for dep in info["required"].as_array().cloned().unwrap_or_default() {
            let dep_id = js_string(&dep["id"]);
            w.names.insert(dep_id.clone(), dep["name"].clone());
            if !(w.is_installed)(&dep_id) {
                visit(w, dep_id, depth + 1).await;
            }
        }
        w.order.push(id);
    })
}

// Löst Abhängigkeiten rekursiv auf. Gibt die IDs in Installationsreihenfolge zurück (Abhängigkeiten zuerst).
pub async fn resolve_dependencies(root_ids: &[String], is_installed: &(dyn Fn(&str) -> bool + Sync)) -> (Vec<String>, Map<String, Value>) {
    let mut w = DepWalk { visited: HashSet::new(), order: vec![], names: Map::new(), is_installed };
    for id in root_ids {
        visit(&mut w, id.clone(), 0).await;
    }
    (w.order, w.names)
}

pub fn parse_id(input: &str) -> String {
    static A: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[?&]id=(\d+)").unwrap());
    static B: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{6,})$").unwrap());
    static C: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{6,})").unwrap());
    let s = crate::xml::js_trim(input);
    [&*A, &*B, &*C].iter().find_map(|re| re.captures(s)).map(|m| m[1].to_string()).unwrap_or_default()
}

type ResFut<'a> = Pin<Box<dyn Future<Output = Res<()>> + Send + 'a>>;

fn walk<'a>(cid: String, depth: u32, seen: &'a mut HashSet<String>, items: &'a mut Vec<String>) -> ResFut<'a> {
    Box::pin(async move {
        if seen.contains(&cid) || depth > 3 {
            return Ok(());
        }
        seen.insert(cid.clone());
        let res = post_api(
            "GetCollectionDetails",
            &[("collectioncount".into(), "1".into()), ("publishedfileids[0]".into(), cid.clone())],
        )
        .await?;
        let entry = &res["collectiondetails"][0];
        if !truthy(entry) || entry["result"] != json!(1) || !truthy(&entry["children"]) {
            if depth == 0 {
                return Err(AppError::tr("err.notCollection"));
            }
            return Ok(());
        }
        for c in entry["children"].as_array().cloned().unwrap_or_default() {
            if c["filetype"] == json!(2) {
                walk(js_string(&c["publishedfileid"]), depth + 1, seen, items).await?;
            } else {
                items.push(js_string(&c["publishedfileid"]));
            }
        }
        Ok(())
    })
}

// Inhalt einer Collection (inkl. verschachtelter Collections).
pub async fn collection(input: &str) -> Res<Value> {
    let id = parse_id(input);
    if id.is_empty() {
        return Err(AppError::tr("err.invalidCollection"));
    }
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    walk(id.clone(), 0, &mut seen, &mut items).await?;
    let info = details(&[id.clone()]).await?.into_iter().next().unwrap_or(Value::Null);
    let mods = details(&items).await?;
    let pick = |key: &str, def: &str| info.get(key).filter(|v| truthy(v)).cloned().unwrap_or(json!(def));
    Ok(json!({ "id": id, "title": pick("title", "Collection"), "preview": pick("preview", ""), "author": pick("author", ""), "items": mods }))
}
