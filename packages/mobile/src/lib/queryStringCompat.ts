// Expo Router 4 imports a namespace from query-string. Patched releases expose
// a default object; retain the Router API without pinning the vulnerable parser.
import queryString from 'query-string';

export const { stringify, parse, extract, parseUrl, stringifyUrl, pick, exclude } = queryString;
export default queryString;
