/**
 * 将闲鱼 MTOP 搜索 JSON 规范为列表项（与 search-local.html 逻辑一致，便于关键词匹配）
 */

/** 与前端展示一致：保留接口里的换行，仅统一换行符 */
function normalizeTextNewlines(s) {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

function formatPublishMs(msStr) {
  let n = Number(msStr)
  if (!Number.isFinite(n) || n <= 0) return ''
  // 接口多为毫秒；若为 10 位秒级时间戳则换算
  if (n < 1e12) n *= 1000
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 闲鱼卡片字段常为 string，也可能是 { name/text/... }；展平后再截断，避免 [object Object]
 */
function humanizeApiLeaf(v, maxLen = 48) {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim().slice(0, maxLen)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, maxLen)
  if (typeof v === 'boolean') return (v ? '是' : '否').slice(0, maxLen)
  if (Array.isArray(v)) {
    const parts = []
    for (const el of v) {
      const s = humanizeApiLeaf(el, maxLen)
      if (s) parts.push(s)
    }
    return parts.join('、').slice(0, maxLen)
  }
  if (typeof v === 'object') {
    const prefer = [
      'name',
      'title',
      'text',
      'label',
      'content',
      'desc',
      'creditLevelName',
      'levelName',
      'tagName',
      'shortText',
      'richText',
      'value'
    ]
    for (const k of prefer) {
      const sub = v[k]
      const s = humanizeApiLeaf(sub, maxLen)
      if (s) return s
    }
    for (const k of Object.keys(v)) {
      const sub = v[k]
      if (sub == null || typeof sub === 'object') continue
      const s = humanizeApiLeaf(sub, maxLen)
      if (s) return s
    }
  }
  try {
    const s = String(v).trim()
    if (s === '[object Object]') return ''
    return s.slice(0, maxLen)
  } catch {
    return ''
  }
}

function pickFishTagLine(main, rKey) {
  const list = main?.exContent?.fishTags?.[rKey]?.tagList
  if (!Array.isArray(list)) return ''
  for (const t of list) {
    const typ = t?.data?.type
    const c = t?.data?.content
    if (typ === 'img' || c == null || c === '') continue
    const s = humanizeApiLeaf(c, 120)
    if (s) return s
  }
  return ''
}

const SELLER_NICK_KEY_RE =
  /^(userNickName|userNick|sellerNick|seller_nick|nickName|displayNick)$/i

function walkPickSellerNick(node, depth, seen) {
  if (node == null || depth > 8 || typeof node !== 'object') return ''
  if (seen.has(node)) return ''
  seen.add(node)
  if (Array.isArray(node)) {
    for (const el of node) {
      const s = walkPickSellerNick(el, depth + 1, seen)
      if (s) return s
    }
    return ''
  }
  for (const k of Object.keys(node)) {
    if (!SELLER_NICK_KEY_RE.test(k)) continue
    const s = humanizeApiLeaf(node[k], 80)
    if (s && s.length <= 64) return s
  }
  for (const k of Object.keys(node)) {
    if (/^(picUrl|pics|img|image|targetUrl|clickParam)$/i.test(k)) continue
    const s = walkPickSellerNick(node[k], depth + 1, seen)
    if (s) return s
  }
  return ''
}

function pickSellerNickFromFeedItem(item, main, ex, args, card) {
  const direct = humanizeApiLeaf(
    ex?.userNickName ||
      ex?.detailParams?.userNick ||
      ex?.detailParams?.userNickName ||
      ex?.userNick ||
      main?.userNickName ||
      main?.userNick ||
      args?.seller_nick ||
      args?.user_nick ||
      args?.userNick ||
      card?.sellerNick ||
      card?.userNick ||
      card?.nickName ||
      card?.detailParams?.userNick ||
      '',
    80
  )
  if (direct) return direct
  return walkPickSellerNick(item, 0, new Set())
}

/**
 * 店铺列表等接口里，店铺展示名可能与 userNick 分字段；尽量从卡片 OR 链上取出。
 */
function pickShopDisplayNameFromPayload(ex, args, card, itemData) {
  const shopInfo = card?.shopInfo || itemData?.shopInfo || args?.shopInfo || {}
  const buckets = [shopInfo, ex?.detailParams, ex, args, card, itemData].filter(Boolean)
  const keys = [
    'shopName',
    'shopTitle',
    'fishShopName',
    'sellerShopName',
    'xyhShopName',
    'storeName',
    'shopNick',
    'sellerShopNick',
    'idleShopName',
    'displayShopTitle',
    'sellerShopTitle'
  ]
  for (const src of buckets) {
    for (const k of keys) {
      const s = humanizeApiLeaf(src[k], 120)
      if (s) return s
    }
  }
  return ''
}

/** PC 搜索 fishTags 验货宝 img 官方素材（与抓包一致；接口未带回 url 时兜底） */
const YANHUOBAO_BADGE_ICON_URL =
  'https://gw.alicdn.com/imgextra/i3/O1CN01gVzTNw1nMrFzcRUFt_!!6000000005076-2-tps-123-48.png'

/** fishTags 包邮角标官方图（接口未带回 url 时兜底） */
const BAOYOU_BADGE_ICON_URL =
  'https://gw.alicdn.com/imgextra/i1/O1CN017BILHl1VNARooBnhe_!!6000000002640-2-tps-84-60.png'

/** fishTags 「严选」角标官方图（接口未带回 url 时兜底） */
const YANXUAN_BADGE_ICON_URL =
  'https://gw.alicdn.com/imgextra/i2/O1CN01V8UW8I29a4E9bdKba_!!6000000008083-2-tps-96-48.png'

/** fishTags 「转卖」角标官方图（接口未带回 url 时兜底） */
const ZHUANMAI_BADGE_ICON_URL =
  'https://gw.alicdn.com/imgextra/i4/O1CN01XvCqH21nK6t1i8suh_!!6000000005070-2-tps-84-60.png'

/** 角标图 URL 是否与验货宝相关（列表卡小蓝标常为图而不是文字） */
function fishImgLooksLikeYanhuobao(d) {
  const blob = [d?.imgUrl, d?.url, d?.picUrl, d?.icon, d?.content]
    .filter((x) => x != null && x !== '')
    .map((x) => String(x))
    .join('\0')
  if (!blob) return false
  return /验货|yanhuo|yhb|appraise|huobao/i.test(blob)
}

/** 角标图是否与包邮相关（白黄底「包邮」小标等） */
function fishImgLooksLikeBaoyou(d) {
  const blob = [d?.imgUrl, d?.url, d?.picUrl, d?.icon, d?.content]
    .filter((x) => x != null && x !== '')
    .map((x) => String(x))
    .join('\0')
  if (!blob) return false
  if (/O1CN017BILHl/i.test(blob)) return true
  return /包邮|baoyou|freeShipping|free_post|freePost/i.test(blob)
}

/** 角标图是否与闲鱼严选等相关 */
function fishImgLooksLikeYanxuan(d) {
  const blob = [d?.imgUrl, d?.url, d?.picUrl, d?.icon, d?.content]
    .filter((x) => x != null && x !== '')
    .map((x) => String(x))
    .join('\0')
  if (!blob) return false
  if (/O1CN01V8UW8I2/i.test(blob)) return true
  return /严选|yanxuan|strictPick|strict_pick|strictPickIcon/i.test(blob)
}

/** 角标图是否与「转卖」/一键转卖等相关（与「专卖」含义不同） */
function fishImgLooksLikeZhuanmai(d) {
  const blob = [d?.imgUrl, d?.url, d?.picUrl, d?.icon, d?.content]
    .filter((x) => x != null && x !== '')
    .map((x) => String(x))
    .join('\0')
  if (!blob) return false
  if (/O1CN01XvCqH2/i.test(blob)) return true
  return /转卖|zhuanmai|resale|resell|secondHand|oneKeyResell|idleFishTransfer|一键转卖/i.test(blob)
}

function normalizeFishIconUrl(u) {
  let s = String(u || '').trim().slice(0, 512)
  if (!s) return ''
  if (s.startsWith('//')) s = `https:${s}`
  if (s.startsWith('http://')) s = `https://${s.slice(7)}`
  return s
}

/** fishTags 里 img 角标：包邮 / 验货宝等，带官方 icon URL */
function labelForFishImgTag(d) {
  const content = humanizeApiLeaf(d.content, 48)
  if (!content && fishImgLooksLikeYanhuobao(d)) return '验货宝'
  if (!content && fishImgLooksLikeBaoyou(d)) return '包邮'
  if (!content && fishImgLooksLikeYanxuan(d)) return '严选'
  if (!content && fishImgLooksLikeZhuanmai(d)) return '转卖'
  if (/freeShipping/i.test(content) || content === 'freeShippingIcon') return '包邮'
  if (/yanxuan|strictPick/i.test(content)) return '严选'
  if (/zhuanmai|resale|oneKeyResell|resellIcon|secondHand/i.test(content)) return '转卖'
  if (content && /验货/.test(content)) return content.slice(0, 24)
  if (fishImgLooksLikeYanhuobao(d)) return '验货宝'
  if (fishImgLooksLikeBaoyou(d)) return '包邮'
  if (fishImgLooksLikeYanxuan(d)) return '严选'
  if (fishImgLooksLikeZhuanmai(d)) return '转卖'
  return content ? content.slice(0, 24) : '服务'
}

/**
 * 从 fishTags 拆出：验货宝文案、服务保障类标签、可能落在标签里的信用文案
 * r1/r2 多为发布时间行，文字标签从 r3 起更干净，但验货角标可能出现在任意行
 */
function extractLabelsFromFishTags(main) {
  let yanhuobaoLabel = ''
  let yanhuobaoIconUrl = ''
  const serviceIcons = []
  const serviceLabels = []
  const creditCandidates = []
  let wantLabelFromTags = ''
  let buyerCreditFromTags = ''
  let baoyouMentioned = false
  let yanxuanMentioned = false
  let zhuanmaiMentioned = false
  const seen = new Set()
  const seenIconUrls = new Set()

  const tagsRoot = main?.exContent?.fishTags
  if (!tagsRoot || typeof tagsRoot !== 'object') {
    return {
      yanhuobaoLabel,
      yanhuobaoIconUrl,
      serviceIcons,
      serviceLabels,
      creditFromTags: '',
      wantLabelFromTags,
      buyerCreditFromTags
    }
  }

  for (const rKey of Object.keys(tagsRoot)) {
    const skipPlainText = rKey === 'r1' || rKey === 'r2'
    const list = tagsRoot[rKey]?.tagList
    if (!Array.isArray(list)) continue

    for (const t of list) {
      const d = t?.data || {}
      if (d.type === 'img') {
        const url = normalizeFishIconUrl(d.url || d.imgUrl || d.picUrl)
        const isYhb = fishImgLooksLikeYanhuobao(d) || /验货/.test(humanizeApiLeaf(d.content, 48))
        if (isYhb) {
          if (!yanhuobaoLabel) yanhuobaoLabel = '验货宝'
          const yhbUrl = url || YANHUOBAO_BADGE_ICON_URL
          if (!yanhuobaoIconUrl) yanhuobaoIconUrl = yhbUrl
          if (!seenIconUrls.has(yhbUrl)) {
            seenIconUrls.add(yhbUrl)
            serviceIcons.push({ label: '验货宝', url: yhbUrl })
          }
          continue
        }
        const baoyouLbl = labelForFishImgTag(d)
        const isBy =
          fishImgLooksLikeBaoyou(d) ||
          baoyouLbl === '包邮' ||
          (/包邮/.test(baoyouLbl) && !fishImgLooksLikeYanhuobao(d))
        if (isBy) {
          baoyouMentioned = true
          const byUrl = url || BAOYOU_BADGE_ICON_URL
          if (!seenIconUrls.has(byUrl)) {
            seenIconUrls.add(byUrl)
            serviceIcons.push({ label: '包邮', url: byUrl })
          }
          continue
        }
        const yxLbl = labelForFishImgTag(d)
        const isYx =
          fishImgLooksLikeYanxuan(d) ||
          yxLbl === '严选' ||
          (/严选/.test(yxLbl) && !fishImgLooksLikeYanhuobao(d))
        if (isYx) {
          yanxuanMentioned = true
          const yxUrl = url || YANXUAN_BADGE_ICON_URL
          if (!seenIconUrls.has(yxUrl)) {
            seenIconUrls.add(yxUrl)
            serviceIcons.push({ label: '严选', url: yxUrl })
          }
          continue
        }
        const zmLbl = labelForFishImgTag(d)
        const isZm =
          fishImgLooksLikeZhuanmai(d) ||
          zmLbl === '转卖' ||
          (/转卖/.test(zmLbl) && !fishImgLooksLikeYanhuobao(d))
        if (isZm) {
          zhuanmaiMentioned = true
          const zmUrl = url || ZHUANMAI_BADGE_ICON_URL
          if (!seenIconUrls.has(zmUrl)) {
            seenIconUrls.add(zmUrl)
            serviceIcons.push({ label: '转卖', url: zmUrl })
          }
          continue
        }
        if (url && !seenIconUrls.has(url)) {
          seenIconUrls.add(url)
          const lbl = labelForFishImgTag(d)
          serviceIcons.push({ label: lbl.slice(0, 24), url })
        }
        continue
      }
      const c = humanizeApiLeaf(d.content, 48)
      if (!c || seen.has(c)) continue

      if (c.includes('验货')) {
        seen.add(c)
        if (!yanhuobaoLabel) yanhuobaoLabel = c.slice(0, 48)
        continue
      }

      if (c.includes('包邮')) baoyouMentioned = true

      if (c.includes('严选')) yanxuanMentioned = true

      if (c.includes('转卖')) zhuanmaiMentioned = true

      const mWant = c.match(/(\d+)\s*人\s*想要/)
      if (mWant) {
        seen.add(c)
        if (!wantLabelFromTags) wantLabelFromTags = `${mWant[1]}人想要`
        continue
      }

      if (/买家信用|买家需|买家.*芝麻|芝麻.*买家/.test(c)) {
        seen.add(c)
        if (!buyerCreditFromTags) buyerCreditFromTags = c.slice(0, 48)
        continue
      }

      if (/卖家信用|信用极好|信用优秀|信用良好|芝麻信用|芝麻分/.test(c)) {
        seen.add(c)
        creditCandidates.push(c)
        continue
      }

      if (!skipPlainText) {
        seen.add(c)
        serviceLabels.push(c)
      }
    }
  }

  const creditFromTags = creditCandidates[0] ? String(creditCandidates[0]).slice(0, 40) : ''
  if (yanhuobaoLabel && !yanhuobaoIconUrl) {
    yanhuobaoIconUrl = YANHUOBAO_BADGE_ICON_URL
    if (!seenIconUrls.has(yanhuobaoIconUrl)) {
      seenIconUrls.add(yanhuobaoIconUrl)
      serviceIcons.push({
        label: yanhuobaoLabel.slice(0, 24) || '验货宝',
        url: yanhuobaoIconUrl
      })
    }
  }
  const hasBaoyouIcon = serviceIcons.some((x) => String(x?.label || '').trim() === '包邮')
  if (baoyouMentioned && !hasBaoyouIcon) {
    const byUrl = BAOYOU_BADGE_ICON_URL
    if (!seenIconUrls.has(byUrl)) {
      seenIconUrls.add(byUrl)
      serviceIcons.push({ label: '包邮', url: byUrl })
    }
  }
  const hasYanxuanIcon = serviceIcons.some((x) => String(x?.label || '').trim() === '严选')
  if (yanxuanMentioned && !hasYanxuanIcon) {
    const yxUrl = YANXUAN_BADGE_ICON_URL
    if (!seenIconUrls.has(yxUrl)) {
      seenIconUrls.add(yxUrl)
      serviceIcons.push({ label: '严选', url: yxUrl })
    }
  }
  const hasZhuanmaiIcon = serviceIcons.some((x) => String(x?.label || '').trim() === '转卖')
  if (zhuanmaiMentioned && !hasZhuanmaiIcon) {
    const zmUrl = ZHUANMAI_BADGE_ICON_URL
    if (!seenIconUrls.has(zmUrl)) {
      seenIconUrls.add(zmUrl)
      serviceIcons.push({ label: '转卖', url: zmUrl })
    }
  }
  return {
    yanhuobaoLabel: yanhuobaoLabel.slice(0, 48),
    yanhuobaoIconUrl: yanhuobaoIconUrl.slice(0, 512),
    serviceIcons: serviceIcons.slice(0, 8),
    serviceLabels: serviceLabels.map((s) => s.slice(0, 48)).slice(0, 8),
    creditFromTags,
    wantLabelFromTags,
    buyerCreditFromTags
  }
}

function pickSellerCreditFromPayload(ex, main, card, args, itemData) {
  const buckets = [
    ex?.detailParams,
    ex,
    args,
    main?.clickParam?.args,
    card,
    itemData
  ].filter(Boolean)

  const keys = [
    'userCreditLevel',
    'sellerCreditLevel',
    'creditLevel',
    'sellerCredit',
    'creditLevelName',
    'sellerCreditLevelName',
    'userReputation',
    'userReputationLevel',
    'sellerGoodRate',
    'userCreditUrlName',
    'fishOrderLabel',
    'sellerFishOrderLabel',
    'sellerLevel',
    'userFishShopLabel',
    'zhimaScore',
    'zhima_score',
    'sesameCreditScore',
    'sesameLevel',
    'sellerSesameLevel'
  ]

  for (const src of buckets) {
    for (const k of keys) {
      const v = src[k]
      if (v == null) continue
      const s = humanizeApiLeaf(v, 40)
      if (s) return s
    }
  }
  return ''
}

/** 多少人想要：结构化字段优先，否则依赖 fishTags 文案 */
function pickWantCountFromPayload(ex, args, card, itemData) {
  const buckets = [args, ex?.detailParams, ex, card, itemData].filter(Boolean)
  const keys = [
    'wishCount',
    'wish_count',
    'wantCount',
    'want_count',
    'wantNum',
    'favCount',
    'favoriteCount',
    'collectCount',
    'itemWantCount',
    'wantUserCount',
    'want_user_count',
    'itemCollectCount',
    'collectNum'
  ]
  for (const src of buckets) {
    for (const k of keys) {
      const v = src[k]
      if (v == null) continue
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10)
      if (Number.isFinite(n) && n >= 0 && n <= 9_999_999) return n
    }
  }
  return null
}

function pickBuyerCreditFromPayload(ex, main, card, args, itemData) {
  const buckets = [ex?.detailParams, ex, args, main?.clickParam?.args, card, itemData].filter(Boolean)
  const keys = [
    'buyerCredit',
    'buyer_credit',
    'buyerCreditLevel',
    'buyer_credit_level',
    'buyerZhimaLevel',
    'buyer_zhima_level',
    'buyerSesameLevel',
    'needBuyerCredit',
    'tradeRuleBuyerCredit',
    'itemBuyerCreditText',
    'buyerRequireZhima',
    'buyerZhimaText'
  ]
  for (const src of buckets) {
    for (const k of keys) {
      const v = src[k]
      if (v == null) continue
      const s = humanizeApiLeaf(v, 40)
      if (s) return s
    }
  }
  return ''
}

/** 归一化图片 URL（http/https，// 补全） */
function sanitizePicUrl(u) {
  let s = String(u == null ? '' : u).trim()
  if (!s) return ''
  if (s.startsWith('//')) s = `https:${s}`
  if (!/^https?:\/\//i.test(s)) return ''
  return s
}

/**
 * 与闲鱼 PC 同源头像地址（p_search-index.js：userAvatar.action）
 * 搜索卡片里常不写直链，只带 userId，需拼此 URL 才有图。
 */
function buildGoofishUserAvatarUrl(userId, pixel = '120') {
  const id = String(userId == null ? '' : userId).trim()
  if (!id) return ''
  const px = String(pixel || '120').replace(/\D/g, '') || '120'
  return `https://api.goofish.com/m/userAvatar.action?id=${encodeURIComponent(id)}&needHttps=1&suffix=_${px}x${px}.jpg`
}

/**
 * 从搜索卡片尽量收集图片 URL（原样汇总，角标/实拍交由前端展示时过滤）。
 * @returns {string[]} 去重保序
 */
function collectPicsFromFeedItem(item, main, ex, card) {
  const seen = new Set()
  const order = []

  function add(u) {
    const s = sanitizePicUrl(u)
    if (!s || seen.has(s)) return
    seen.add(s)
    order.push(s)
  }

  function addFromArray(arr) {
    if (!Array.isArray(arr)) return
    for (const el of arr) {
      if (el == null) continue
      if (typeof el === 'string') add(el)
      else if (typeof el === 'object') {
        add(el.url || el.picUrl || el.src || el.imageUrl || el.cover || el.pic || el.imgUrl)
      }
    }
  }

  // 常见单图字段
  add(ex?.picUrl)
  add(ex?.superUniquePic)
  add(ex?.pic?.url)
  add(card?.picInfo?.picUrl)
  add(card?.coverImage)
  add(card?.image)
  add(card?.pic)
  add(item?.data?.picUrl)
  add(item?.data?.coverImage)

  // 常见多图数组
  addFromArray(ex?.picUrls)
  addFromArray(ex?.pics)
  addFromArray(ex?.images)
  addFromArray(ex?.imageList)
  addFromArray(ex?.picList)
  addFromArray(card?.pics)
  addFromArray(card?.images)
  addFromArray(card?.imageList)
  addFromArray(card?.picList)
  addFromArray(card?.picInfo?.pics)
  addFromArray(card?.picInfo?.picList)
  addFromArray(card?.picInfo?.urls)
  addFromArray(item?.data?.pics)

  const dp = ex?.detailParams || {}
  add(dp.picUrl)
  add(dp.coverUrl)
  addFromArray(dp.pics)
  addFromArray(dp.images)

  const tagsRoot = main?.exContent?.fishTags
  if (tagsRoot && typeof tagsRoot === 'object') {
    for (const rKey of Object.keys(tagsRoot)) {
      const list = tagsRoot[rKey]?.tagList
      if (!Array.isArray(list)) continue
      for (const t of list) {
        if (t?.data?.type !== 'img') continue
        const d = t.data
        add(d.imgUrl)
        add(d.url)
        add(d.picUrl)
        add(d.icon)
        const c = d.content
        if (typeof c === 'string' && (/^https?:|^\/\//.test(c) || c.includes('alicdn.com'))) add(c)
      }
    }
  }

  return order
}

/**
 * 疑似明文闲鱼用户 ID（纯数字、长度适中）。列表里另有加密串时不应把长串误判为明文。
 * @param {unknown} s
 */
function isLikelyPlainGoofishUserId(s) {
  const t = String(s ?? '').trim()
  if (!t || t.length > 20) return false
  return /^\d{6,20}$/.test(t)
}

/**
 * 与历史版本一致：`sellerUserId` 取 OR 链上第一个非空字符串；另从链上收集去重顺序列表，供黑名单与明文拆分。
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} ex
 * @param {Record<string, unknown>} main
 * @param {Record<string, unknown>} card
 * @param {Record<string, unknown>} itemData
 * @returns {{ sellerUserId: string, orderedUnique: string[] }}
 */
function legacyOrderedSellerIdParts(args, ex, main, card, itemData) {
  const parts = [
    args.user_id,
    args.userId,
    args.seller_id,
    args.sellerId,
    args.seller_user_id,
    args.trackParams?.sellerId,
    args.trackParams?.userId,
    ex?.userId,
    ex?.sellerId,
    ex?.trackParams?.sellerId,
    ex?.trackParams?.userId,
    ex?.detailParams?.userId,
    ex?.detailParams?.sellerId,
    ex?.userInfo?.userId,
    ex?.sellerInfo?.userId,
    main?.sellerUserId,
    main?.userId,
    main?.trackParams?.sellerId,
    main?.trackParams?.userId,
    card?.userId,
    card?.sellerId,
    card?.trackParams?.sellerId,
    itemData?.userId,
    itemData?.sellerUserId,
    itemData?.seller?.userId,
    itemData?.seller?.sellerId
  ]
  let sellerUserId = ''
  const orderedUnique = []
  const seen = new Set()
  for (const v of parts) {
    if (v == null || typeof v === 'object') continue
    const t = String(v).trim()
    if (!t) continue
    if (!sellerUserId) sellerUserId = t
    if (seen.has(t)) continue
    seen.add(t)
    orderedUnique.push(t)
  }
  return { sellerUserId, orderedUnique }
}

/** 从 fleamarket / goofish 跳转链或 trackParamsJson 中解析商品 id */
function parseItemIdFromTargetUrl(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  let m = s.match(/[?&]id=(\d{8,20})/i)
  if (m) return m[1]
  m = s.match(/item_id["']?\s*[:=]\s*["']?(\d{8,20})/i)
  if (m) return m[1]
  return ''
}

/** 店铺 cardList 常用 cardData，搜索用 data；统一解析卡片根节点（与手机端同源） */
function resolveFeedCardRoots(item) {
  const dataRoot =
    (item?.data && typeof item.data === 'object' && item.data) ||
    (item?.cardData && typeof item.cardData === 'object' && item.cardData) ||
    (item && typeof item === 'object' ? item : {})
  const itemNode = dataRoot?.item || item?.item || {}
  const main = itemNode?.main || itemNode || {}
  const ex = main?.exContent || itemNode?.exContent || dataRoot?.exContent || {}
  const clickParam = main?.clickParam || itemNode?.clickParam || dataRoot?.clickParam || {}
  const args = clickParam?.args || {}
  return { dataRoot, itemNode, main, ex, args, card: dataRoot }
}

function shallowFindNumericItemId(obj, depth, seen) {
  if (!obj || typeof obj !== 'object' || depth > 5) return ''
  if (!seen) seen = new Set()
  if (seen.has(obj)) return ''
  seen.add(obj)
  const idKeys = ['item_id', 'itemId', 'id', 'auctionId', 'auction_id']
  for (const k of idKeys) {
    const t = String(obj[k] != null ? obj[k] : '').trim()
    if (/^\d{8,20}$/.test(t)) return t
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === 'string') {
      const fromUrl = parseItemIdFromTargetUrl(v)
      if (fromUrl) return fromUrl
      continue
    }
    if (!v || typeof v !== 'object') continue
    const nested = shallowFindNumericItemId(v, depth + 1, seen)
    if (nested) return nested
  }
  return ''
}

/** 从搜索/店铺列表卡片 OR 链提取 itemId */
function pickItemIdFromFeedItem(item, main, ex, args, card, itemNode, dataRoot) {
  const dp = ex?.detailParams || {}
  const track =
    main?.trackParams || card?.trackParams || item?.data?.trackParams || item?.trackParams || {}
  const jumpArgs = ex?.jump2XianYuHao?.clickParam?.args || card?.jump2XianYuHao?.clickParam?.args || {}
  const buckets = [
    args,
    jumpArgs,
    dp,
    ex,
    card,
    itemNode,
    dataRoot,
    item,
    item?.data,
    item?.cardData,
    main,
    track,
    card?.itemDO,
    dataRoot?.itemDO,
    item?.data?.itemDO,
    dataRoot?.item,
    card?.itemInfo,
    dataRoot?.itemInfo
  ].filter((b) => b && typeof b === 'object')
  const keys = ['item_id', 'itemId', 'id', 'auctionId', 'auction_id']
  for (const src of buckets) {
    for (const k of keys) {
      const t = String(src[k] != null ? src[k] : '').trim()
      if (/^\d{8,20}$/.test(t)) return t
    }
  }
  const urls = [
    main?.targetUrl,
    card?.targetUrl,
    itemNode?.targetUrl,
    item?.targetUrl,
    item?.data?.targetUrl,
    item?.cardData?.targetUrl,
    dataRoot?.targetUrl,
    args?.targetUrl,
    card?.itemDO?.targetUrl,
    dataRoot?.itemDO?.targetUrl
  ]
  for (const u of urls) {
    const id = parseItemIdFromTargetUrl(u)
    if (id) return id
  }
  return (
    shallowFindNumericItemId(dataRoot, 0, null) ||
    shallowFindNumericItemId(itemNode, 0, null) ||
    shallowFindNumericItemId(item, 0, null) ||
    ''
  )
}

/**
 * 从 PC 搜索 MTOP JSON 取服务端命中总数（用于分页上限；与抓包 data.resultInfo.searchResControlFields 一致）
 * @param {unknown} json
 * @returns {number | null}
 */
function pickSearchNumFoundFromMtopJson(json) {
  const raw = json?.data?.resultInfo?.searchResControlFields?.numFound
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

function normalizeItems(json) {
  const roots = [json?.data?.resultList, json?.data?.items, json?.data?.list, json?.data?.cardList]
  const raw = roots.find(Array.isArray) || []
  return raw.map((item) => {
    const { dataRoot, itemNode, main, ex, args, card } = resolveFeedCardRoots(item)

    const shortTitle =
      (ex?.title && String(ex.title).split('\n')[0]) ||
      ex?.detailParams?.title?.split?.('\n')?.[0] ||
      card?.title ||
      card?.itemTitle ||
      card?.name ||
      '未命名商品'

    const detailTitleRaw = ex?.detailParams?.title || ex?.title || shortTitle
    const detailTitle = normalizeTextNewlines(detailTitleRaw) || '未命名商品'

    const priceArr = Array.isArray(ex?.price) ? ex.price : []
    const joinedPrice = priceArr.map((p) => String(p?.text || '')).join('').trim()
    const price =
      joinedPrice ||
      ex?.detailParams?.soldPrice ||
      args?.displayPrice ||
      args?.price ||
      card?.priceInfo?.price ||
      card?.price ||
      card?.showPrice ||
      ''

    const dp = ex?.detailParams || card?.detailParams || {}
    const itemDO = card?.itemDO || item?.data?.itemDO || {}
    /** 店铺 xyh.item.list 地区字段常落在 detailParams / args，不全在 ex.area */
    const city = humanizeApiLeaf(
      ex?.area ||
        dp?.area ||
        dp?.city ||
        dp?.location ||
        dp?.province ||
        args?.area ||
        args?.city ||
        args?.location ||
        args?.divisionName ||
        card?.location ||
        card?.area ||
        card?.city ||
        card?.province ||
        itemDO?.area ||
        itemDO?.city ||
        itemDO?.location ||
        item?.data?.area ||
        item?.data?.city ||
        '',
      48
    )
    const pics = collectPicsFromFeedItem(item, main, ex, card)
    const pic = pics[0] || ''
    const seller = pickSellerNickFromFeedItem(item, main, ex, args, card)
    const shopName = pickShopDisplayNameFromPayload(ex, args, card, dataRoot)

    const { sellerUserId, orderedUnique } = legacyOrderedSellerIdParts(args, ex, main, card, dataRoot)
    const sellerPlainUserId = orderedUnique.find(isLikelyPlainGoofishUserId) || ''
    const nonPlainOrdered = orderedUnique.filter((t) => !isLikelyPlainGoofishUserId(t))
    const sellerBlacklistId =
      nonPlainOrdered[0] ||
      (sellerUserId && !isLikelyPlainGoofishUserId(sellerUserId) ? sellerUserId : '')

    let sellerAvatar = sanitizePicUrl(
      ex?.sellerAvatarUrl ||
        ex?.userAvatarUrl ||
        ex?.userAvatar ||
        ex?.userPhoto ||
        ex?.sellerAvatar ||
        ex?.detailParams?.userAvatar ||
        ex?.detailParams?.sellerAvatarUrl ||
        ex?.detailParams?.sellerPhoto ||
        card?.sellerAvatarUrl ||
        card?.userAvatarUrl ||
        card?.userAvatar ||
        card?.sellerAvatar ||
        card?.userPhoto ||
        item?.data?.userAvatar ||
        item?.data?.sellerAvatarUrl ||
        dataRoot?.userAvatar ||
        dataRoot?.sellerAvatarUrl ||
        main?.userAvatar ||
        ''
    )
    if (!sellerAvatar && sellerUserId) {
      sellerAvatar = buildGoofishUserAvatarUrl(sellerUserId)
    }

    /** 店铺 xyh.item.list 等有时不落 args.publishTime，多路径兜底便于上新时间窗判定 */
    const publishTimeMsRaw =
      args.publishTime ??
      args.gmtCreate ??
      args.createTime ??
      dp?.publishTime ??
      dp?.gmtCreate ??
      dp?.createTime ??
      ex?.detailParams?.publishTime ??
      card?.publishTime ??
      card?.gmtCreate ??
      card?.createTime ??
      card?.onlineTime ??
      card?.lastOnline ??
      itemDO?.gmtCreate ??
      itemDO?.publishTime ??
      itemDO?.gmtModified ??
      item?.gmtCreate ??
      item?.data?.gmtCreate ??
      item?.data?.publishTime
    const publishTimeMs = String(publishTimeMsRaw != null ? publishTimeMsRaw : '').trim()
    const publishLabel =
      pickFishTagLine(main, 'r2') || pickFishTagLine(main, 'r1') || pickFishTagLine(main, 'r3') || ''
    const publishTimeText = formatPublishMs(publishTimeMs)
    // fishTags 在「最新发布」下常为「刚刚发布」，会盖住真实时间戳；有毫秒时间时优先展示具体发布时间
    let timeDisplay = ''
    if (publishTimeText) {
      timeDisplay =
        publishLabel && publishLabel !== '刚刚发布'
          ? `${publishLabel} · 发布于 ${publishTimeText}`
          : `发布于 ${publishTimeText}`
    } else if (publishLabel) {
      timeDisplay = publishLabel
    }

    const itemId = pickItemIdFromFeedItem(item, main, ex, args, card, itemNode, dataRoot)

    const tagPack = extractLabelsFromFishTags(main)
    let yanhuobaoLabel = tagPack.yanhuobaoLabel || ''
    const dpExtras = ex?.detailParams || {}
    if (!yanhuobaoLabel) {
      const cand = [dpExtras.appraiseTitle, dpExtras.fishAppraiseName, ex?.appraiseTitle].find((x) => {
        const s = humanizeApiLeaf(x, 48)
        return s && s.includes('验货')
      })
      if (cand) yanhuobaoLabel = humanizeApiLeaf(cand, 48)
    }
    let sellerCredit =
      pickSellerCreditFromPayload(ex, main, card, args, dataRoot) || tagPack.creditFromTags || ''
    sellerCredit = humanizeApiLeaf(sellerCredit, 40)
    const serviceLabels = Array.isArray(tagPack.serviceLabels) ? tagPack.serviceLabels : []
    let yanhuobaoIconUrl = normalizeFishIconUrl(tagPack.yanhuobaoIconUrl)
    let serviceIcons = Array.isArray(tagPack.serviceIcons) ? tagPack.serviceIcons.slice(0, 8) : []
    if (yanhuobaoLabel && !yanhuobaoIconUrl) {
      yanhuobaoIconUrl = YANHUOBAO_BADGE_ICON_URL
      if (!serviceIcons.some((x) => String(x?.url || '') === yanhuobaoIconUrl)) {
        serviceIcons = [
          { label: humanizeApiLeaf(yanhuobaoLabel, 24) || '验货宝', url: yanhuobaoIconUrl },
          ...serviceIcons
        ].slice(0, 8)
      }
    }

    const wantNum = pickWantCountFromPayload(ex, args, card, dataRoot)
    let wantLabel = ''
    if (wantNum != null) wantLabel = `${wantNum}人想要`
    else if (tagPack.wantLabelFromTags) wantLabel = tagPack.wantLabelFromTags

    let buyerCreditLabel =
      pickBuyerCreditFromPayload(ex, main, card, args, dataRoot) || tagPack.buyerCreditFromTags || ''
    buyerCreditLabel = humanizeApiLeaf(buyerCreditLabel, 40)

    return {
      // 列表卡接口常带多行标题；shortTitle 仅首行用于旧逻辑，对外统一用全文
      title: detailTitle,
      detailTitle,
      price: String(price || '待询价'),
      city: String(city || ''),
      pic: String(pic || ''),
      pics,
      seller: String(seller || ''),
      /** 接口若单独下发店铺名（鱼小铺/企业店等），与 seller（昵称）可能不同 */
      shopName: String(shopName || '').trim().slice(0, 120),
      sellerUserId,
      /** 与搜索列表一致，用于全局商家黑名单精确匹配（常为加密串；有明文时仍可与 sellerUserId 并存） */
      sellerBlacklistId,
      /** 同一条卡片 OR 链上出现的明文 userId（若有，可与 sellerUserId 首值不同） */
      sellerPlainUserId,
      sellerAvatar: String(sellerAvatar || ''),
      publishTimeMs,
      publishTimeText,
      publishLabel: String(publishLabel || ''),
      timeDisplay: String(timeDisplay || ''),
      yanhuobaoLabel: humanizeApiLeaf(yanhuobaoLabel, 48),
      yanhuobaoIconUrl,
      sellerCredit: humanizeApiLeaf(sellerCredit, 40),
      wantLabel: String(wantLabel || '').trim().slice(0, 32),
      buyerCreditLabel: humanizeApiLeaf(buyerCreditLabel, 40),
      serviceLabels,
      serviceIcons,
      itemId
    }
  })
}

module.exports = { normalizeItems, pickSearchNumFoundFromMtopJson }
