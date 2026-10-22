/// <reference types="nativewind/types" />

// `app/_layout.tsx` imports `../global.css` for its side effect (NativeWind's
// Metro transform owns it at bundle time). TypeScript 6 reports TS2882 for a
// side-effect import it cannot resolve, so declare the module shape here.
declare module '*.css';
