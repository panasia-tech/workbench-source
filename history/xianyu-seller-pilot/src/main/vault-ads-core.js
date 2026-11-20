// 密码库填进 AdsPower 的算法部分（不碰 Electron，离线回归直接测：scripts/test/vault-ads-regression.mjs）。
//
// 服务端（server/app/services/ledger_vault_ads.py）用这台电脑的 X25519 公钥加密：临时密钥对 + ECDH →
// HKDF-SHA256（salt = 临时公钥 ‖ 本机公钥，info = panasia-vault-ads-v1）→ AES-256-GCM，附加数据是「条目 id|电脑 id」。
// 这里是同一套算法的解密。私钥只在本机，怎么存见 vault-ads.js。
import { createHash, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto'

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const HKDF_INFO = Buffer.from('panasia-vault-ads-v1')

/** 新的一对密钥：私钥 PKCS8 DER（交给系统加密存），公钥 32 字节 base64（交给服务端）。 */
export function newKeyPair() {
  const { privateKey } = generateKeyPairSync('x25519')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' })
  return { privDer, pubB64: publicKeyOf(privDer) }
}

export function publicKeyOf(privDer) {
  const pub = createPublicKey(createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' }))
  return pub.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length).toString('base64')
}

/** 32 字节原始私钥 → PKCS8 DER（测试夹具用） */
export function privDerFromRaw(raw) {
  return Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)])
}

/** 和服务端同一个算法：公钥 SHA-256 前 8 字节，四位一组。批准时两边对着看。 */
export function fingerprint(pubB64) {
  const h = createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16).toUpperCase()
  return h.match(/.{4}/g).join(' ')
}

export function aadFor(itemId, stationId) {
  return Buffer.from(`${itemId}|${stationId}`)
}

/** 解开服务端发来的包，返回明文 Buffer；不是给这台电脑的、被改过的都会抛错。 */
export function openBox(privDer, box, aad) {
  if (!box || box.v !== 1) throw new Error('包的格式不认识')
  const privateKey = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' })
  const epk = Buffer.from(box.epk, 'base64')
  const pub = Buffer.from(publicKeyOf(privDer), 'base64')
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, epk]), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey, publicKey })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, pub]), HKDF_INFO, 32))
  const raw = Buffer.from(box.ct, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.nonce, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()])
  key.fill(0)
  return plain
}

// AdsPower user/update 的字段名（v1）：登录名 username、密码 password、二次验证种子 fakey、网站 domain_name
const FIELDS = [['username', 'username'], ['password', 'password'], ['fakey', 'fakey'], ['domain', 'domain_name']]

/**
 * 填一条：解包 → 写 AdsPower → 读回来核对 → 返回要交给服务端的结果 { ack, ok, verified, error }。
 * write(body) / read(userId) 由调方注入（vault-ads.js 里是本机 AdsPower）。
 *
 * 「写操作别信返回码」（user/update 改分组会假成功）：写完一定读回来比。AdsPower 读回来没有的字段（比如种子）
 * 比不了就不比；但登录名、密码至少要比上一项，一项都比不上就算没核对成，交「填失败」让人去看。
 */
export async function processItem(item, { privDer, stationId, write, read }) {
  const payload = JSON.parse(openBox(privDer, item.box, aadFor(item.item_id, stationId)).toString('utf8'))
  const ack = payload.ack
  try {
    if (payload.item_id !== item.item_id || payload.ads_user_id !== item.ads_user_id) {
      return { ack, ok: false, verified: false, error: '包里的条目和环境对不上' }
    }
    const body = { user_id: String(payload.ads_user_id) }
    for (const [from, to] of FIELDS) if (payload[from]) body[to] = String(payload[from])
    if (!body.username && !body.password && !body.fakey) return { ack, ok: false, verified: false, error: '这条没有可填的内容' }
    try {
      await write(body)
    } catch (error) {
      return { ack, ok: false, verified: false, error: `写 AdsPower 失败：${String(error?.message || error).slice(0, 120)}` }
    }
    let rec
    try {
      rec = await read(body.user_id)
    } catch (error) {
      return { ack, ok: true, verified: false, error: `写完读不回来：${String(error?.message || error).slice(0, 120)}` }
    }
    if (!rec) return { ack, ok: true, verified: false, error: '写完在 AdsPower 里找不到这个环境' }
    const wrong = []
    let checked = 0
    for (const [, to] of FIELDS) {
      if (!(to in body) || rec[to] === undefined || rec[to] === null) continue
      if (String(rec[to]) !== body[to]) wrong.push(to)
      else if (to === 'username' || to === 'password') checked += 1
    }
    if (wrong.length) return { ack, ok: true, verified: false, error: `写进去了但读回来对不上：${wrong.join('、')}` }
    if (!checked) return { ack, ok: true, verified: false, error: 'AdsPower 读不回登录名和密码，没法核对，请到 AdsPower 里看一眼' }
    return { ack, ok: true, verified: true, error: null }
  } finally {
    // 明文只在这一小段里用：用完清掉，别留在长期对象上
    for (const k of ['username', 'password', 'fakey', 'ack']) payload[k] = ''
  }
}
