// Nachsichtiger XML-Leser für About.xml mit derselben Ausgabe wie fast-xml-parser in dieser Konfiguration
// (ignoreAttributes, parseTagValue: false, trimValues, processEntities, <li> immer als Liste):
// - Blatt-Elemente werden zu Strings, leere Elemente zu ""
// - Elemente mit Kindern werden zu Objekten, Text daneben landet in "#text"
// - nur die fünf XML-Entities werden aufgelöst, numerische (&#39;) bleiben stehen
// - Zeilenenden werden zu \n, <?xml ...?> wird zum Schlüssel "?xml"
// - ein schließendes Tag schließt immer das aktuelle Element (falscher Name ist kein Fehler)
use serde_json::{Map, Value};

#[derive(Default)]
struct Node {
    name: String,
    children: Vec<Node>,
    text: String,
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn save_text(buf: &mut String, node: &mut Node) {
    let t = js_trim(buf);
    if !t.is_empty() {
        node.text.push_str(&decode_entities(t));
    }
    buf.clear();
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn find(data: &str, from: usize, pat: &str) -> Result<usize, String> {
    data[from..].find(pat).map(|i| from + i).ok_or_else(|| format!("Unexpected end: '{pat}' not found"))
}

/// Ende eines Tags (`>`), Anführungszeichen in Attributen werden übersprungen.
fn tag_end(data: &str, from: usize) -> Result<usize, String> {
    let mut quote: Option<char> = None;
    for (i, c) in data[from..].char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '>' => return Ok(from + i),
            None => {}
        }
    }
    Err("Unexpected end of tag".into())
}

pub fn parse(data: &str) -> Result<Value, String> {
    // Zeilenenden wie im XML-Standard vereinheitlichen.
    let data = &data.replace("\r\n", "\n").replace('\r', "\n");
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut buf = String::new();
    let mut i = 0;
    while i < data.len() {
        let rest = &data[i..];
        if !rest.starts_with('<') {
            let c = rest.chars().next().unwrap();
            buf.push(c);
            i += c.len_utf8();
            continue;
        }
        if rest.starts_with("</") {
            let end = find(data, i, ">")?;
            save_text(&mut buf, stack.last_mut().unwrap());
            if stack.len() > 1 {
                let node = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(node);
            }
            i = end + 1;
        } else if rest.starts_with("<?") {
            let end = find(data, i, "?>")?;
            let name = data[i + 2..end].split(|c: char| c.is_whitespace()).next().unwrap_or_default();
            save_text(&mut buf, stack.last_mut().unwrap());
            stack.last_mut().unwrap().children.push(Node { name: format!("?{name}"), ..Default::default() });
            i = end + 2;
        } else if rest.starts_with("<!--") {
            i = find(data, i, "-->")? + 3;
        } else if rest.starts_with("<![CDATA[") {
            let end = find(data, i, "]]>")?;
            save_text(&mut buf, stack.last_mut().unwrap());
            stack.last_mut().unwrap().text.push_str(&data[i + 9..end]);
            i = end + 3;
        } else if rest.starts_with("<!") {
            // DOCTYPE inkl. interner Teilmenge [...]
            let mut depth = 0;
            let mut end = None;
            for (n, c) in rest.char_indices().skip(2) {
                match c {
                    '[' => depth += 1,
                    ']' => depth -= 1,
                    '>' if depth <= 0 => {
                        end = Some(i + n);
                        break;
                    }
                    _ => {}
                }
            }
            i = end.ok_or("Unexpected end of DOCTYPE")? + 1;
        } else {
            let end = tag_end(data, i + 1)?;
            let exp = &data[i + 1..end];
            let self_closing = exp.ends_with('/');
            let exp = if self_closing { &exp[..exp.len() - 1] } else { exp };
            let name = exp.split(|c: char| c.is_whitespace()).next().unwrap_or_default().to_string();
            save_text(&mut buf, stack.last_mut().unwrap());
            let node = Node { name, ..Default::default() };
            if self_closing {
                stack.last_mut().unwrap().children.push(node);
            } else {
                stack.push(node);
            }
            i = end + 1;
        }
    }
    // Nicht geschlossene Elemente übernehmen.
    save_text(&mut buf, stack.last_mut().unwrap());
    while stack.len() > 1 {
        let node = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(node);
    }
    Ok(children_object(&stack[0]))
}

fn children_object(node: &Node) -> Value {
    let mut map = Map::new();
    for child in &node.children {
        let value = to_value(child);
        match map.get_mut(&child.name) {
            Some(Value::Array(arr)) if child.name == "li" || arr.len() > 0 => arr.push(value),
            Some(existing) => {
                let first = existing.take();
                *existing = Value::Array(vec![first, value]);
            }
            None if child.name == "li" => {
                map.insert(child.name.clone(), Value::Array(vec![value]));
            }
            None => {
                map.insert(child.name.clone(), value);
            }
        }
    }
    if !node.text.is_empty() {
        map.insert("#text".into(), Value::String(node.text.clone()));
    }
    Value::Object(map)
}

fn to_value(node: &Node) -> Value {
    if node.children.is_empty() {
        Value::String(node.text.clone())
    } else {
        children_object(node)
    }
}

// Erwartete Werte wurden mit fast-xml-parser (Konfiguration oben) erzeugt.
#[cfg(test)]
mod tests {
    use super::parse;
    use serde_json::json;

    #[test]
    fn matches_fast_xml_parser() {
        let cases = [
            (
                r#"<?xml version="1.0"?><!-- c --><ModMetaData><name> A &amp; B &#39; &nbsp; </name><e/><e2></e2><mix>t1<b>x</b> t2 </mix><cd><![CDATA[ <raw> &amp; ]]></cd><rep>1</rep><rep>2</rep><one><li>a</li><li/></one><bad>x</wrong></bad><after>y</after></ModMetaData>"#,
                json!({ "?xml": "", "ModMetaData": { "name": "A & B &#39; &nbsp;", "e": "", "e2": "", "mix": { "b": "x", "#text": "t1t2" }, "cd": " <raw> &amp; ", "rep": ["1", "2"], "one": { "li": ["a", ""] }, "bad": "x" }, "after": "y" }),
            ),
            (
                "\u{feff}<ModMetaData><packageId>X.Y</packageId><supportedVersions><li>1.5</li><li>1.6</li></supportedVersions><description>Line\\nTwo &lt;b&gt;bold&lt;/b&gt;</description><modDependencies><li><packageId>a.b</packageId><displayName>AB</displayName></li></modDependencies></ModMetaData>",
                json!({ "ModMetaData": { "packageId": "X.Y", "supportedVersions": { "li": ["1.5", "1.6"] }, "description": "Line\\nTwo <b>bold</b>", "modDependencies": { "li": [{ "packageId": "a.b", "displayName": "AB" }] } } }),
            ),
            (
                r#"<!DOCTYPE x [ <!ENTITY a "b"> ]><ModMetaData><name attr="1 > 0">N</name><loadAfter><li>Core</li></loadAfter><unclosed><li>z</li></ModMetaData>"#,
                json!({ "ModMetaData": { "name": "N", "loadAfter": { "li": ["Core"] }, "unclosed": { "li": ["z"] } } }),
            ),
            (
                "<ModMetaData>\r\n<description>a\r\nb\rc</description>\r\n</ModMetaData>",
                json!({ "ModMetaData": { "description": "a\nb\nc" } }),
            ),
        ];
        for (xml, expected) in cases {
            assert_eq!(parse(xml).unwrap(), expected, "{xml}");
        }
    }
}
