/** Build-time stand-in for node:net and node:dns/promises (see wxt.config.ts). Never called in the extension. */
const unavailable = (): never => {
  throw new Error("not available in the extension");
};
export const isIP = (): number => 0;
export const lookup = unavailable;
export default { isIP, lookup };
