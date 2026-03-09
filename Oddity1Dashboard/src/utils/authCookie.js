const COOKIE_NAME = 'oddity1_auth'
const IS_PROD = !['localhost', '127.0.0.1'].includes(window.location.hostname)
const COOKIE_DOMAIN = IS_PROD ? '.oddity1.com' : ''
const SECURE_FLAG = IS_PROD ? '; Secure' : ''

export function setAuthCookie() {
  document.cookie = `${COOKIE_NAME}=true; domain=${COOKIE_DOMAIN}; path=/; max-age=${60 * 60 * 24 * 30}${SECURE_FLAG}; SameSite=Lax`
}

export function clearAuthCookie() {
  document.cookie = `${COOKIE_NAME}=; domain=${COOKIE_DOMAIN}; path=/; max-age=0${SECURE_FLAG}; SameSite=Lax`
}

export function hasAuthCookie() {
  return document.cookie.split(';').some(c => c.trim().startsWith(`${COOKIE_NAME}=`))
}
