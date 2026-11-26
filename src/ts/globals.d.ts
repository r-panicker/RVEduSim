// What is on window besides the modules' exports: the CodeMirror 6 bundle
// (ui/cm6-loader.ts loads it), the desktop app's bridge (electron/
// preload.js), the hooks the test suites set before the page loads, and
// the editor objects the page leaves there for them.

declare var CM6: any;

interface Window {
  CM6?: any;
  rvNative?: any;
  __CM6_DISABLE_CDN?: boolean;
  __mockGodboltResponse?: any;
  cmEditor?: any;
  languageCompartment?: any;
}
