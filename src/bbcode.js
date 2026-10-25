// Wandelt Steam-BBCode in sicheres HTML um (Text wird zuerst escaped, nur bekannte Tags werden ersetzt).
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = (u) => {
    const url = String(u || '').trim().replace(/^&quot;|&quot;$/g, '').replace(/&amp;/g, '&');
    return /^(https?:)?\/\//i.test(url) ? esc(url.startsWith('//') ? 'https:' + url : url) : '';
  };

  function bbcode(input) {
    if (!input) return '';
    const noparse = [];
    let s = String(input).replace(/\[noparse\]([\s\S]*?)\[\/noparse\]/gi, (_, t) => {
      noparse.push(esc(t));
      return `\u0000${noparse.length - 1}\u0000`;
    });
    s = esc(s).replace(/\r\n?/g, '\n');

    const simple = [
      [/\[b\]([\s\S]*?)\[\/b\]/gi, '<b>$1</b>'],
      [/\[i\]([\s\S]*?)\[\/i\]/gi, '<i>$1</i>'],
      [/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>'],
      [/\[(?:strike|s)\]([\s\S]*?)\[\/(?:strike|s)\]/gi, '<s>$1</s>'],
      [/\[h1\]\s*([\s\S]*?)\s*\[\/h1\]\n?/gi, '<h1>$1</h1>'],
      [/\[h2\]\s*([\s\S]*?)\s*\[\/h2\]\n?/gi, '<h2>$1</h2>'],
      [/\[h3\]\s*([\s\S]*?)\s*\[\/h3\]\n?/gi, '<h3>$1</h3>'],
      [/\[quote(?:=[^\]]*)?\]\s*([\s\S]*?)\s*\[\/quote\]\n?/gi, '<blockquote>$1</blockquote>'],
      [/\[code\]\n?([\s\S]*?)\[\/code\]\n?/gi, '<pre>$1</pre>'],
      [/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '<span class="spoiler">$1</span>'],
      [/\[hr\]\[\/hr\]\n?|\[hr\]\n?/gi, '<hr>'],
      [/\[table[^\]]*\]\s*/gi, '<table>'], [/\s*\[\/table\]\n?/gi, '</table>'],
      [/\[tr\]\s*/gi, '<tr>'], [/\s*\[\/tr\]\s*/gi, '</tr>'],
      [/\[th\]/gi, '<th>'], [/\[\/th\]\s*/gi, '</th>'],
      [/\[td\]/gi, '<td>'], [/\[\/td\]\s*/gi, '</td>']
    ];
    for (let pass = 0; pass < 2; pass++) for (const [re, rep] of simple) s = s.replace(re, rep);

    s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, u, t) => {
      const href = safeUrl(u);
      return href ? `<a href="${href}" target="_blank">${t}</a>` : t;
    });
    s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_, u) => {
      const href = safeUrl(u);
      return href ? `<a href="${href}" target="_blank">${u}</a>` : u;
    });
    s = s.replace(/\[img(?:=[^\]]*)?\]([\s\S]*?)\[\/img\]/gi, (_, u) => {
      const src = safeUrl(u);
      return src ? `<img src="${src}" loading="lazy" alt="">` : '';
    });
    s = s.replace(/\[previewyoutube=([\w-]+)[^\]]*\]\[\/previewyoutube\]/gi,
      (_, id) => `<a href="https://www.youtube.com/watch?v=${id}" target="_blank">▶ YouTube-Video ansehen</a>`);

    // Listen
    const list = (tag, open, close) => {
      const re = new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${tag}\\]\\n?`, 'gi');
      s = s.replace(re, (_, body) => {
        const items = body.split(/\[\*\]/).map((x) => x.trim()).filter(Boolean);
        return open + items.map((x) => `<li>${x.replace(/\n/g, '<br>')}</li>`).join('') + close;
      });
    };
    for (let i = 0; i < 2; i++) {
      list('list', '<ul>', '</ul>');
      list('olist', '<ol>', '</ol>');
    }

    // Unbekannte Tags entfernen, Zeilenumbrüche
    s = s.replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, '');
    s = s.replace(/\n/g, '<br>').replace(/(<\/(h1|h2|h3|ul|ol|table|blockquote|pre)>|<hr>)<br>/g, '$1');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => noparse[+i]);
    // Nackte URLs verlinken
    s = s.replace(/(^|[\s>])(?![^<]*<\/a>)(https?:\/\/[^\s<]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank">${u}</a>`);
    return s;
  }

  window.bbcode = bbcode;
  window.escapeHtml = esc;
})();
