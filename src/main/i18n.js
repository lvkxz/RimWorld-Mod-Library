// Übersetzung im Hauptprozess. Die Sprache setzt main.js aus den Einstellungen.
const shared = require('../shared/i18n');

let language = 'en';

function setLanguage(lang) {
  language = shared.normalize(lang);
}

function tr(key, params) {
  return shared.translate(language, key, params);
}

module.exports = { setLanguage, tr, has: shared.has };
