// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual ErrorScreen handlers, installed Next 16 retry, and native SSR controls.
// Transition completion is controlled here; this is not mounted/browser proof.
import { createRequire } from "node:module";
import { createElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundaryHandler } from "next/dist/client/components/error-boundary";
import ErrorScreen from "../../src/app/error";
import { Button } from "../../src/components/ui/Action";
import { fenceFetch, makeChecker } from "./_harness";

type Props = Record<string, unknown>;
function retryButton(tree: unknown): ComponentProps<typeof Button> {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      try { return retryButton(child); } catch { /* another child */ }
    }
  } else if (isValidElement<Props>(tree)) {
    if (tree.type === Button) return tree.props as ComponentProps<typeof Button>;
    return retryButton(tree.props.children);
  }
  throw new Error("The actual retry button was not found");
}

function mount(render: () => ReactNode) {
  const react = createRequire(__filename)("react") as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  let index = 0, transitionSlot = -1;
  const dispatcher = {
    useRef(initial: unknown) {
      const slot = index++;
      if (!(slot in cells)) cells[slot] = { current: initial };
      return cells[slot];
    },
    useEffect(effect: () => void, deps?: unknown[]) {
      const slot = index++, previous = cells[slot] as unknown[] | undefined;
      if (!deps || !previous || deps.some((value, i) => !Object.is(value, previous[i]))) effects.push(effect);
      cells[slot] = deps;
    },
    useTransition() {
      const slot = index++;
      transitionSlot = slot;
      if (!(slot in cells)) cells[slot] = false;
      return [cells[slot], (action: () => void) => {
        cells[slot] = true;
        action(); // Next's public retry returns void, not a request Promise.
      }];
    },
  };
  return {
    render() {
      index = 0;
      const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
      react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
      try {
        const tree = render();
        effects.splice(0).forEach((effect) => effect());
        return tree;
      } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; }
    },
    settle() { cells[transitionSlot] = false; },
  };
}

function main() {
  const c = makeChecker(), fence = fenceFetch();
  const navigation = createRequire(__filename)("next/navigation") as { usePathname: () => string | null };
  const originalPathname = navigation.usePathname;
  let pathname: string | null = "/review";
  navigation.usePathname = () => pathname;
  const originalError = console.error, logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const calls: string[] = [];
    let error = Object.assign(new Error("private fixture error details"), { digest: "fixture-reference-1" });
    const boundary = new ErrorBoundaryHandler({ pathname: "/review", errorComponent: ErrorScreen });
    boundary.context = {
      refresh() { calls.push("refresh current route"); },
      back() { calls.push("back"); }, forward() { calls.push("forward"); },
      push() { calls.push("push"); }, replace() { calls.push("replace"); }, prefetch() { calls.push("prefetch"); },
    };
    boundary.setState = (update) => {
      if (update && typeof update !== "function") {
        boundary.state = { ...boundary.state, ...update };
        calls.push("reset");
      }
    };
    boundary.reset();
    c.ok("installed reset alone cannot request current server data", calls.join(",") === "reset");
    calls.length = 0;
    const mounted = mount(() => ErrorScreen({ error, unstable_retry: boundary.unstable_retry }));
    const first = retryButton(mounted.render());
    const click = (props: ComponentProps<typeof Button>) => props.onClick?.({} as Parameters<NonNullable<typeof props.onClick>>[0]);
    click(first); click(first);
    c.ok("actual retry invokes installed framework refresh before boundary reset", calls.join(",") === "refresh current route,reset");
    c.ok("duplicate handler before a render cannot issue another refresh", calls.length === 2);
    const busy = Button(retryButton(mounted.render()));
    c.ok("pending retry has a disabled native button and accessible busy label", busy.props.disabled === true && busy.props["aria-busy"] === true && renderToStaticMarkup(busy).includes("Loading current information"));
    click(retryButton(mounted.render()));
    c.ok("rerenders during the transition keep duplicate retry blocked", calls.length === 2);
    mounted.settle();
    error = Object.assign(new Error("second fixture read failure"), { digest: "fixture-reference-2" });
    const failedAgain = retryButton(mounted.render());
    c.ok("a settled failed read offers another explicit retry", Button(failedAgain).props.disabled === false);
    click(failedAgain);
    c.ok("next explicit retry refetches without navigation or mutation", calls.join(",") === "refresh current route,reset,refresh current route,reset");
    c.ok("each new error retains its own log reference", logged.length === 2 && logged[0][1] === "fixture-reference-1" && logged[1][1] === "fixture-reference-2");

    const html = renderToStaticMarkup(createElement(ErrorScreen, { error, unstable_retry: boundary.unstable_retry }));
    c.ok("SSR explains saved information and interrupted-action uncertainty", html.includes("current saved information") && html.includes("check its recorded status") && html.includes("Unsaved text may need") && !html.includes("nothing was lost"));
    c.ok("SSR exposes the reference without private error details", html.includes("fixture-reference-2") && !html.includes("second fixture read failure"));
    const controls = html.match(/<(?:button|a)\b[^>]*>/g) ?? [];
    c.ok("all three native controls retain shared touch and keyboard focus targets", controls.length === 3 && controls.every((tag) => tag.includes("min-h-11") && tag.includes("min-w-11") && tag.includes("focus-visible:outline-2")));
    c.ok("ordinary home and report navigation remain available", html.includes('href="/"') && html.includes('href="/feedback"') && html.includes("Try again"));
    const noReference = renderToStaticMarkup(createElement(ErrorScreen, { error: new Error("fixture"), unstable_retry: boundary.unstable_retry }));
    c.ok("missing digest does not invent a reference or lose recovery controls", !noReference.includes("Reference:") && noReference.includes("if shown") && noReference.includes('href="/feedback"'));
    for (const path of ["/portal", "/portal/me", "/portal/login", "/portal/opaque-test-token"]) {
      pathname = path;
      const portal = renderToStaticMarkup(createElement(ErrorScreen, { error, unstable_retry: boundary.unstable_retry }));
      c.ok(`${path} offers portal recovery without staff-only destinations`, portal.includes('href="/portal/me"') && portal.includes("Back to your portal") && portal.includes("usual contact channel") && !portal.includes('href="/feedback"') && !portal.includes('href="/"') && portal.includes("check its recorded status") && portal.includes("fixture-reference-2"));
      c.ok(`${path} keeps native retry and shared portal touch/focus targets`, (portal.match(/<(?:button|a)\b[^>]*>/g) ?? []).length === 2 && portal.includes("Try again") && portal.includes("min-h-11") && portal.includes("focus-visible:outline-2"));
    }
    for (const path of ["/portals", null]) {
      pathname = path;
      const office = renderToStaticMarkup(createElement(ErrorScreen, { error, unstable_retry: boundary.unstable_retry }));
      c.ok("segment boundary or unavailable pathname retains existing office destinations", office.includes('href="/"') && office.includes('href="/feedback"') && !office.includes("Back to your portal"));
    }
    c.ok("fixture performs no provider or network requests", fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { console.error = originalError; navigation.usePathname = originalPathname; fence.restore(); }
}
main();
