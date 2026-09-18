// A drill runs the app's server modules outside Next. `@/lib/auth/user` imports
// `redirect` from "next/navigation" at module scope, and under the
// `react-server` condition (which `server-only` requires) that package resolves
// to a CLIENT module built on React.createContext — which does not exist in the
// react-server build. The drill never renders and never redirects, so the
// import is stubbed rather than the whole auth module mocked: everything else
// in the chain stays the REAL shipped code, which is the point of a drill.
const nope = (name) => () => {
  throw new Error(`next/navigation.${name}() is not available in a drill`);
};
module.exports = {
  redirect: nope("redirect"),
  permanentRedirect: nope("permanentRedirect"),
  notFound: nope("notFound"),
  forbidden: nope("forbidden"),
  unauthorized: nope("unauthorized"),
  RedirectType: { push: "push", replace: "replace" },
  useRouter: nope("useRouter"),
  usePathname: nope("usePathname"),
  useSearchParams: nope("useSearchParams"),
  useParams: nope("useParams"),
};
