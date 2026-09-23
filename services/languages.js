// T-20: Idiomas suportados pelo Whisper (paridade com o concorrente).
// Lista canônica única: o backend valida o parâmetro `language` com ela e o
// frontend monta o select do modal de upload. UMD para os dois mundos.
//
// Códigos ISO-639-1 (whisper-large-v3; `yue` = cantonês, extensão do large-v3).
// Nome em inglês + nome nativo para a busca do select.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WHISPER_LANGUAGES = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LANGUAGES = [
    { code: 'pt', name: 'Portuguese', native: 'Português' },
    { code: 'en', name: 'English', native: 'English' },
    { code: 'es', name: 'Spanish', native: 'Español' },
    { code: 'ja', name: 'Japanese', native: '日本語' },
    { code: 'af', name: 'Afrikaans', native: 'Afrikaans' },
    { code: 'am', name: 'Amharic', native: 'አማርኛ' },
    { code: 'ar', name: 'Arabic', native: 'العربية' },
    { code: 'as', name: 'Assamese', native: 'অসমীয়া' },
    { code: 'az', name: 'Azerbaijani', native: 'Azərbaycanca' },
    { code: 'ba', name: 'Bashkir', native: 'Башҡортса' },
    { code: 'be', name: 'Belarusian', native: 'Беларуская' },
    { code: 'bg', name: 'Bulgarian', native: 'Български' },
    { code: 'bn', name: 'Bengali', native: 'বাংলা' },
    { code: 'bo', name: 'Tibetan', native: 'བོད་ཡིག' },
    { code: 'br', name: 'Breton', native: 'Brezhoneg' },
    { code: 'bs', name: 'Bosnian', native: 'Bosanski' },
    { code: 'ca', name: 'Catalan', native: 'Català' },
    { code: 'cs', name: 'Czech', native: 'Čeština' },
    { code: 'cy', name: 'Welsh', native: 'Cymraeg' },
    { code: 'da', name: 'Danish', native: 'Dansk' },
    { code: 'de', name: 'German', native: 'Deutsch' },
    { code: 'el', name: 'Greek', native: 'Ελληνικά' },
    { code: 'et', name: 'Estonian', native: 'Eesti' },
    { code: 'eu', name: 'Basque', native: 'Euskara' },
    { code: 'fa', name: 'Persian', native: 'فارسی' },
    { code: 'fi', name: 'Finnish', native: 'Suomi' },
    { code: 'fo', name: 'Faroese', native: 'Føroyskt' },
    { code: 'fr', name: 'French', native: 'Français' },
    { code: 'gl', name: 'Galician', native: 'Galego' },
    { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી' },
    { code: 'ha', name: 'Hausa', native: 'Hausa' },
    { code: 'haw', name: 'Hawaiian', native: 'ʻŌlelo Hawaiʻi' },
    { code: 'he', name: 'Hebrew', native: 'עברית' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
    { code: 'hr', name: 'Croatian', native: 'Hrvatski' },
    { code: 'ht', name: 'Haitian Creole', native: 'Kreyòl Ayisyen' },
    { code: 'hu', name: 'Hungarian', native: 'Magyar' },
    { code: 'hy', name: 'Armenian', native: 'Հայերեն' },
    { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
    { code: 'is', name: 'Icelandic', native: 'Íslenska' },
    { code: 'it', name: 'Italian', native: 'Italiano' },
    { code: 'jw', name: 'Javanese', native: 'Basa Jawa' },
    { code: 'ka', name: 'Georgian', native: 'ქართული' },
    { code: 'kk', name: 'Kazakh', native: 'Қазақша' },
    { code: 'km', name: 'Khmer', native: 'ខ្មែរ' },
    { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
    { code: 'ko', name: 'Korean', native: '한국어' },
    { code: 'la', name: 'Latin', native: 'Latina' },
    { code: 'lb', name: 'Luxembourgish', native: 'Lëtzebuergesch' },
    { code: 'ln', name: 'Lingala', native: 'Lingála' },
    { code: 'lo', name: 'Lao', native: 'ລາວ' },
    { code: 'lt', name: 'Lithuanian', native: 'Lietuvių' },
    { code: 'lv', name: 'Latvian', native: 'Latviešu' },
    { code: 'mg', name: 'Malagasy', native: 'Malagasy' },
    { code: 'mi', name: 'Māori', native: 'Māori' },
    { code: 'mk', name: 'Macedonian', native: 'Македонски' },
    { code: 'ml', name: 'Malayalam', native: 'മലയാളം' },
    { code: 'mn', name: 'Mongolian', native: 'Монгол' },
    { code: 'mr', name: 'Marathi', native: 'मराठी' },
    { code: 'ms', name: 'Malay', native: 'Bahasa Melayu' },
    { code: 'mt', name: 'Maltese', native: 'Malti' },
    { code: 'my', name: 'Burmese', native: 'မြန်မာ' },
    { code: 'ne', name: 'Nepali', native: 'नेपाली' },
    { code: 'nl', name: 'Dutch', native: 'Nederlands' },
    { code: 'nn', name: 'Norwegian Nynorsk', native: 'Nynorsk' },
    { code: 'no', name: 'Norwegian', native: 'Norsk' },
    { code: 'oc', name: 'Occitan', native: 'Occitan' },
    { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
    { code: 'pl', name: 'Polish', native: 'Polski' },
    { code: 'ps', name: 'Pashto', native: 'پښتو' },
    { code: 'ro', name: 'Romanian', native: 'Română' },
    { code: 'ru', name: 'Russian', native: 'Русский' },
    { code: 'sa', name: 'Sanskrit', native: 'संस्कृतम्' },
    { code: 'sd', name: 'Sindhi', native: 'سنڌي' },
    { code: 'si', name: 'Sinhala', native: 'සිංහල' },
    { code: 'sk', name: 'Slovak', native: 'Slovenčina' },
    { code: 'sl', name: 'Slovenian', native: 'Slovenščina' },
    { code: 'sn', name: 'Shona', native: 'chiShona' },
    { code: 'so', name: 'Somali', native: 'Soomaali' },
    { code: 'sq', name: 'Albanian', native: 'Shqip' },
    { code: 'sr', name: 'Serbian', native: 'Српски' },
    { code: 'su', name: 'Sundanese', native: 'Basa Sunda' },
    { code: 'sv', name: 'Swedish', native: 'Svenska' },
    { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
    { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
    { code: 'te', name: 'Telugu', native: 'తెలుగు' },
    { code: 'tg', name: 'Tajik', native: 'Тоҷикӣ' },
    { code: 'th', name: 'Thai', native: 'ไทย' },
    { code: 'tk', name: 'Turkmen', native: 'Türkmençe' },
    { code: 'tl', name: 'Tagalog', native: 'Tagalog' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe' },
    { code: 'tt', name: 'Tatar', native: 'Татарча' },
    { code: 'uk', name: 'Ukrainian', native: 'Українська' },
    { code: 'ur', name: 'Urdu', native: 'اردو' },
    { code: 'uz', name: 'Uzbek', native: 'Oʻzbekcha' },
    { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
    { code: 'yi', name: 'Yiddish', native: 'ייִדיש' },
    { code: 'yo', name: 'Yoruba', native: 'Yorùbá' },
    { code: 'zh', name: 'Chinese', native: '中文' },
    { code: 'yue', name: 'Cantonese', native: '粤语' }
  ];

  // Fixados no topo do select (mais usados no Brasil). pt, en, es, ja.
  const PINNED = ['pt', 'en', 'es', 'ja'];

  const codes = new Set(LANGUAGES.map(l => l.code));

  function isValidLanguage(code) {
    return codes.has(String(code || '').toLowerCase());
  }

  function byCode(code) {
    return LANGUAGES.find(l => l.code === String(code || '').toLowerCase()) || null;
  }

  // Ordem do select: fixados primeiro, depois o resto em ordem alfabética
  // do nome nativo. `term` filtra por nome nativo, inglês ou código.
  function listForSelect(term) {
    const t = String(term || '').trim().toLowerCase();
    const match = l =>
      !t ||
      l.native.toLowerCase().includes(t) ||
      l.name.toLowerCase().includes(t) ||
      l.code.includes(t);
    const pinned = PINNED.map(byCode).filter(l => l && match(l));
    const rest = LANGUAGES.filter(l => !PINNED.includes(l.code) && match(l));
    return [...pinned, ...rest];
  }

  return { LANGUAGES, PINNED, isValidLanguage, byCode, listForSelect };
}));
