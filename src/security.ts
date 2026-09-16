import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function equal(a: string,b: string) { return timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b))); }
export function capability(key: string,global: string,id: string,token: string) {
  return createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify([global,id,token])).digest('base64url');
}
export function seal(value: unknown,key: string) {
  const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
}
export function unseal<T>(value: string,key: string): T {
  const bytes=Buffer.from(value,'base64');
  const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),bytes.subarray(0,12));
  cipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));
}
