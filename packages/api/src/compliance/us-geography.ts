/**
 * US geography the customer-text send window needs: which state a NANP area
 * code belongs to, which IANA zones a state spans, and a normaliser for the
 * free-text state a service address carries.
 *
 * Every table here is used conservatively by `recipientQuietHours`: a state
 * only ever ADDS zones (the window must be open in all of them) and can only
 * tighten the closing hour. So an extra or misattributed entry narrows a
 * window; a missing one leaves the tenant's zone (and the fallbacks) to decide.
 * Keep the area codes current with NANPA.
 */

/**
 * The IANA zones each state (and NANP territory) spans. Multi-zone states list
 * every zone in legal use: the FL panhandle (Central), western KY/TN, NW/SW
 * Indiana, the Michigan UP border counties (Central), western KS/NE/ND/SD and
 * El Paso TX (Mountain), Malheur County OR (Mountain), the Idaho panhandle
 * (Pacific), West Wendover NV (Mountain), the Navajo Nation in AZ (observes
 * DST) and the Aleutians in AK.
 */
const STATE_ZONES: Readonly<Record<string, readonly string[]>> = {
  AL: ['America/Chicago'],
  AK: ['America/Anchorage', 'America/Adak'],
  AZ: ['America/Phoenix', 'America/Denver'],
  AR: ['America/Chicago'],
  CA: ['America/Los_Angeles'],
  CO: ['America/Denver'],
  CT: ['America/New_York'],
  DE: ['America/New_York'],
  DC: ['America/New_York'],
  FL: ['America/New_York', 'America/Chicago'],
  GA: ['America/New_York'],
  HI: ['Pacific/Honolulu'],
  ID: ['America/Boise', 'America/Los_Angeles'],
  IL: ['America/Chicago'],
  IN: ['America/Indiana/Indianapolis', 'America/Chicago'],
  IA: ['America/Chicago'],
  KS: ['America/Chicago', 'America/Denver'],
  KY: ['America/New_York', 'America/Chicago'],
  LA: ['America/Chicago'],
  ME: ['America/New_York'],
  MD: ['America/New_York'],
  MA: ['America/New_York'],
  MI: ['America/Detroit', 'America/Menominee'],
  MN: ['America/Chicago'],
  MS: ['America/Chicago'],
  MO: ['America/Chicago'],
  MT: ['America/Denver'],
  NE: ['America/Chicago', 'America/Denver'],
  NV: ['America/Los_Angeles', 'America/Denver'],
  NH: ['America/New_York'],
  NJ: ['America/New_York'],
  NM: ['America/Denver'],
  NY: ['America/New_York'],
  NC: ['America/New_York'],
  ND: ['America/Chicago', 'America/Denver'],
  OH: ['America/New_York'],
  OK: ['America/Chicago'],
  OR: ['America/Los_Angeles', 'America/Boise'],
  PA: ['America/New_York'],
  RI: ['America/New_York'],
  SC: ['America/New_York'],
  SD: ['America/Chicago', 'America/Denver'],
  TN: ['America/New_York', 'America/Chicago'],
  TX: ['America/Chicago', 'America/Denver'],
  UT: ['America/Denver'],
  VT: ['America/New_York'],
  VA: ['America/New_York'],
  WA: ['America/Los_Angeles'],
  WV: ['America/New_York'],
  WI: ['America/Chicago'],
  WY: ['America/Denver'],
  PR: ['America/Puerto_Rico'],
  VI: ['America/Puerto_Rico'],
  GU: ['Pacific/Guam'],
  MP: ['Pacific/Guam'],
  AS: ['Pacific/Pago_Pago'],
};

/** The zones a USPS state code spans; empty for an unknown code. */
export function zonesForState(code: string): readonly string[] {
  return STATE_ZONES[code] ?? [];
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', districtofcolumbia: 'DC',
  washingtondc: 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE',
  nevada: 'NV', newhampshire: 'NH', newjersey: 'NJ', newmexico: 'NM', newyork: 'NY',
  northcarolina: 'NC', northdakota: 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', rhodeisland: 'RI', southcarolina: 'SC', southdakota: 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY',
  puertorico: 'PR', virginislands: 'VI', usvirginislands: 'VI', guam: 'GU',
  northernmarianaislands: 'MP', americansamoa: 'AS',
  // AP-style and other common abbreviations (periods and spaces are stripped).
  ala: 'AL', ariz: 'AZ', ark: 'AR', calif: 'CA', cal: 'CA', colo: 'CO', conn: 'CT',
  del: 'DE', fla: 'FL', ill: 'IL', ind: 'IN', kan: 'KS', kans: 'KS', mass: 'MA',
  mich: 'MI', minn: 'MN', miss: 'MS', mont: 'MT', neb: 'NE', nebr: 'NE', nev: 'NV',
  okla: 'OK', ore: 'OR', oreg: 'OR', penn: 'PA', penna: 'PA', tenn: 'TN', tex: 'TX',
  wash: 'WA', wva: 'WV', wis: 'WI', wisc: 'WI', wyo: 'WY',
};

/**
 * A free-text state ("FL", " fl ", "Fla.", "Florida", "New York", "W. Va.")
 * as its USPS code, or null when it is not recognisably a US state/territory.
 * Null must be treated as UNKNOWN, never as "not an early-close state".
 */
export function normalizeUsState(input: string): string | null {
  const key = input.toLowerCase().replace(/[^a-z]/g, '');
  if (key.length === 0) return null;
  const asCode = key.toUpperCase();
  if (key.length === 2 && STATE_ZONES[asCode]) return asCode;
  return STATE_NAMES[key] ?? null;
}

/** NANP area codes per state/territory (incl. overlays in service or announced). */
const AREA_CODES: Readonly<Record<string, string>> = {
  AL: '205 251 256 334 483 659 938',
  AK: '907',
  AZ: '480 520 602 623 928',
  AR: '327 479 501 870',
  CA: '209 213 279 310 323 341 350 357 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 837 840 858 909 916 925 949 951',
  CO: '303 719 720 748 970 983',
  CT: '203 475 860 959',
  DE: '302',
  DC: '202 771',
  FL: '239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954',
  GA: '229 404 470 478 678 706 762 770 912 943',
  HI: '808',
  ID: '208 986',
  IL: '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872',
  IN: '219 260 317 463 574 765 812 930',
  IA: '319 515 563 641 712',
  KS: '316 620 785 913',
  KY: '270 364 502 606 859',
  LA: '225 318 337 457 504 985',
  ME: '207',
  MD: '227 240 301 410 443 667',
  MA: '339 351 413 508 617 774 781 857 978',
  MI: '231 248 269 313 517 586 616 679 734 810 906 947 989',
  MN: '218 320 507 612 651 763 924 952',
  MS: '228 601 662 769',
  MO: '235 314 417 557 573 636 660 816 975',
  MT: '406',
  NE: '308 402 531',
  NV: '702 725 775',
  NH: '603',
  NJ: '201 551 609 640 732 848 856 862 908 973',
  NM: '505 575',
  NY: '212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934',
  NC: '252 336 472 704 743 828 910 919 980 984',
  ND: '701',
  OH: '216 220 234 283 326 330 380 419 436 440 513 567 614 740 937',
  OK: '405 539 572 580 918',
  OR: '458 503 541 971',
  PA: '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878',
  RI: '401',
  SC: '803 821 839 843 854 864',
  SD: '605',
  TN: '423 615 629 731 865 901 931',
  TX: '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979',
  UT: '385 435 801',
  VT: '802',
  VA: '276 434 540 571 686 703 757 804 826 948',
  WA: '206 253 360 425 509 564',
  WV: '304 681',
  WI: '262 274 353 414 534 608 715 920',
  WY: '307',
  PR: '787 939',
  VI: '340',
  GU: '671',
  MP: '670',
  AS: '684',
};

const STATE_BY_AREA_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(AREA_CODES).flatMap(([state, codes]) =>
    codes.split(' ').map((code): [string, string] => [code, state]),
  ),
);

/** The state a +1 number's area code belongs to, or null when not recognised. */
export function stateForUsPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return STATE_BY_AREA_CODE.get(national.slice(0, 3)) ?? null;
}
