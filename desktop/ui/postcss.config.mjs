// Tailwind is configured by ./tailwind.config.cjs through its own
// auto-discovery, NOT by options passed here.
//
// The obvious alternative — `tailwindcss: { ...config, content: [absolute
// globs] }`, which would sidestep any cwd question — was tried and silently
// does nothing under Next's Turbopack build: the options object never reaches
// Tailwind, so it runs with an empty content list. `@tailwind base` still
// expands, so preflight lands and the stylesheet looks plausible, but not one
// utility class is emitted, `next build` reports success, and the packaged page
// ships unstyled. Measured: 6,287 bytes of preflight-only CSS with the inline
// form against 20,182 bytes with this one.
//
// Because auto-discovery resolves the config from the process cwd, the build
// must run from THIS directory. `npm run build` and the csproj's BuildDraftUi
// target both do.
//
// `WebView2WindowTests.TheDraftPageIsPackagedNextToTheAppBinary` asserts a real
// utility class is present in the packaged CSS, so this cannot regress quietly.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
