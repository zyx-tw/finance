// The built-in rules: the first pattern found in a description names its
// category. They cover the common cases; everything else goes to the model (ai.ts).

export const CATEGORIES = [
  "Food",
  "Delivery",
  "Groceries",
  "Transport",
  "Shopping",
  "Subscriptions",
  "Telecom",
  "Travel",
  "Health",
  "Entertainment",
  "Education",
  "Housing",
  "Income",
  "Fees",
  "Other",
] as const

export type Category = (typeof CATEGORIES)[number]

const RULES: [Category, RegExp][] = [
  ["Fees", /手續費|年費|利息支出|違約金|FEE\b/],
  ["Income", /利息|薪資|薪水|獎金|股利|退稅/],
  ["Subscriptions", /OPENAI|CHATGPT|ANTHROPIC|CLAUDE|CURSOR|GITHUB|GOOGLE|YOUTUBE|APPLE\.COM|ICLOUD|NETFLIX|SPOTIFY|DISNEY|CLOUDFLARE|SUPABASE|VERCEL|NOTION|FIGMA|ADOBE|MICROSOFT|AWS|AMAZON WEB|TAILSCALE|SUBSCR/],
  ["Delivery", /優步|優食|UBER ?EATS|FOODPANDA|富胖達/],
  ["Transport", /中油|台塑石油|加油|高鐵|台鐵|臺鐵|捷運|悠遊|一卡通|UBER|計程|車隊|停車|ETAG|遠通|公車|客運|GOSHARE|WEMO|IRENT|YOUBIKE/],
  ["Telecom", /台哥大|台灣大哥大|中華電|遠傳電信|亞太電信|台灣之星/],
  ["Groceries", /全聯|家樂福|好市多|COSTCO|大潤發|美廉社|愛買|超市|7-ELEVEN|統一超商|全家便利|萊爾富|OK便利/],
  ["Shopping", /蝦皮|SHOPEE|MOMO|PCHOME|COUPANG|酷澎|TAOBAO|淘寶|AMAZON|IKEA|宜家|百貨|UNIQLO|MUJI|無印|誠品|博客來|安利美特|燦坤|全國電子|APPLE STORE|DECATHLON|迪卡儂/],
  ["Travel", /航空|AIRLINE|AGODA|BOOKING|AIRBNB|TRIP\.COM|KLOOK|KKDAY|HOTEL|飯店|旅館|旅行社/],
  ["Health", /醫院|診所|藥局|藥妝|牙醫|屈臣氏|康是美|健保/],
  ["Entertainment", /影城|電影|KTV|STEAM|NINTENDO|PLAYSTATION|TICKET|售票|KKTIX|拓元/],
  ["Education", /大學|學費|書局|補習|UDEMY|COURSERA/],
  ["Housing", /房租|租金|水費|電費|瓦斯|台灣電力|自來水|管理費/],
  ["Food", /餐|食|飯|麵|壽司|咖啡|COFFEE|星巴克|STARBUCKS|路易莎|茶|飲|料理|鍋|燒|炸雞|漢堡|麥當勞|肯德基|摩斯|早餐|便當|滷味|拉麵|牛排|披薩|PIZZA|BAKERY|麵包|甜點|50嵐|可不可|清心|迷客夏|CAFE/],
]

/** Half-width, upper case and single spaces, so one merchant always reads the same. */
export function normalize(text: string) {
  return text.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").replace(/\s*\*\s*/g, "*").trim()
}

/**
 * The merchant a description names. Payment-app prefixes, store codes and the
 * acquirer's city are noise; every delivery order from one app is one merchant.
 */
export function merchantOf(description: string) {
  let text = normalize(description)
  text = text.replace(/^(連加\*|連支\*|街口\*|全支付\*|悠遊付\*|LINEPAY\*|LINE PAY\*)+/g, "")
  text = text.replace(/\b[A-Z]\d{4}\b/g, " ").replace(/\b(MO)?(TAIPEI|HSINCHU?|TAICHUNG|KAOHSIUNG|TAOYUAN|TAINAN)\b/g, " ")
  if (/^優步-/.test(text)) return "優步"
  if (/^優食/.test(text)) return "優食"
  return text.replace(/\s+/g, " ").trim() || normalize(description)
}

export function categorize(description: string): Category | null {
  const text = normalize(description)
  for (const [category, pattern] of RULES) if (pattern.test(text)) return category
  return null
}
