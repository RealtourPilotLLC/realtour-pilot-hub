// ---------------------------------------------------------------------------
// A STATEFUL FAKE AUTOHDR for the photo-delivery drills (Oct 14 2026).
//
// Built ONLY from AutoHDR's published contract: openapi.json v0.1.0 and
// llms.txt (read Oct 13 2026; docs/photo-delivery/AUTOHDR_API_PLAN.md lists
// the facts used). No live call has ever been made to build it, so every
// shape here is the DOCUMENTED contract:
//   · token: client_credentials, `resource` required, scopes decide spend
//     (a token without photoshoots:write / images:edit gets 403 on a POST)
//   · zero-based paging with page_count; listPhotoshoots = last 7 days only
//   · download: 1 credit per first-time photo, re-downloads free, HEAD only,
//     402 insufficient_credits charges nothing
//   · transforms: catalog credit_cost charged on SUBMIT; failed or no-op
//     (succeeded + null output) refunded; output becomes head when run on the
//     head; a style result or a redo does NOT become head by itself
//   · asset-uploads: kind defaults to "reference"; a reference used as a
//     mask fails with 400 invalid_mask_url; mask_url must be an s3:// URL of
//     THIS shoot
//   · errors: {error, error_description} + X-Request-Id; 422 = {detail:[…]};
//     429 carries Retry-After; 410 photoshoot_expired after 7 days
// The CATALOG (transform names, prices) and MODELS are drill fixtures passed
// in by the caller: the real ones are read at runtime from the live API, and
// the hub never hardcodes them.
//
//   const fake = createFakeAutohdr({ transforms: [...], models: [...], balance: 50 });
//   const fence = fenceFetch((url, init) => fake.handle(url, init));
//   fake.script("POST /v1/transforms", "lose-response")   AutoHDR processes and charges, the caller never hears back
//   fake.script("POST /v1/transforms", { status: 429, retryAfter: 2 })
//   fake.script("GET /v1/transforms/:id", { status: 503 })
//   fake.setJobOutcome(jobId | "next", "failed" | "noop" | "succeeded")
// ---------------------------------------------------------------------------

export type FakeTransform = { name: string; version?: number; display_name?: string; category?: string; credit_cost: number | null; requires_mask?: boolean; input_schema?: unknown; looks?: { id: string; display_name: string; description: string; credit_cost: number | null }[] | null };
export type FakeModel = { id: number; name: string; type: "predefined" | "custom"; variant: "indoor" | "outdoor" | "indoor/outdoor"; style_credit_cost: number };
type Version = { uuid: string; parent: string | null; label: string; description: string | null };
type FakePhoto = { image_uuid: string; name: string; downloaded: boolean; head: string; versions: Version[] };
type FakeIngest = { jobId: string; files: { download_url: string; filename: string; kind: string }[]; committed: boolean; landAfter: number; polls: number };
type FakeShoot = { photoshoot_id: number; address: string; status: "in_progress" | "success" | "failure"; created_at: string; photos: FakePhoto[]; assets: Map<string, "mask" | "reference">; ingest?: FakeIngest };
type FakeJob = {
  job_id: string; photoshoot_id: number; image_uuid: string; image_version_uuid: string; transform_name: string; transform_version: number;
  status: "queued" | "running" | "succeeded" | "failed"; submitted_at: string; updated_at: string; output_image_version_uuid: string | null;
  failure_code: string | null; failure_message: string | null; charged: number; refunded: boolean; makesHead: boolean; outcome: "succeeded" | "failed" | "noop"; polls: number;
};
type Scripted = "lose-response" | { status: number; retryAfter?: number; error?: string };

const API = "https://external.realestatephotoediting.com";
const TOKEN_URL = "https://new.autohdr.com/api/auth/oauth2/token";

export function createFakeAutohdr(opts: { transforms: FakeTransform[]; models?: FakeModel[]; balance?: number; clientId?: string; clientSecret?: string; now?: () => Date; imageBytes?: (versionUuid: string) => Uint8Array | null }) {
  const now = opts.now ?? (() => new Date());
  const state = {
    balance: opts.balance ?? 100,
    shoots: [] as FakeShoot[],
    jobs: [] as FakeJob[],
    tokens: new Map<string, string[]>(), // token -> scopes
    calls: [] as { method: string; path: string; body: unknown; scopes: string[] }[],
    puts: [] as { url: string; contentType: string | null; bytes: number }[],
    scripts: new Map<string, Scripted[]>(),
    nextOutcome: null as null | "succeeded" | "failed" | "noop",
    pollsToFinish: 2,
    /** Oct 14 2026 intake: commits answered 409 files_not_landed before 202; status polls before success; the outcome. */
    intake: { landAfter: 1, processPolls: 2, outcome: "success" as "success" | "failure", recoverAfterFailure: false },
    /** describe's answer by photo name (free check drills); null = "A room." */
    describe: null as null | ((photoName: string, prompt: string) => string),
  };
  let seq = 0;
  const id = (p: string) => `${p}-${(++seq).toString(16).padStart(6, "0")}`;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": id("req"), ...headers } });
  const err = (status: number, error: string, desc = "") => json(status, { error, error_description: desc || error });

  function seedShoot(s: { address: string; photos: { name: string; downloaded?: boolean }[]; createdAt?: Date; status?: FakeShoot["status"] }): FakeShoot {
    const shoot: FakeShoot = {
      photoshoot_id: 1000 + state.shoots.length + 1,
      address: s.address,
      status: s.status ?? "success",
      created_at: (s.createdAt ?? now()).toISOString(),
      assets: new Map(),
      photos: s.photos.map((p) => {
        const original: Version = { uuid: id("ver"), parent: null, label: "Original", description: null };
        const enhanced: Version = { uuid: id("ver"), parent: original.uuid, label: "Enhanced", description: "HDR enhancement" };
        return { image_uuid: id("img"), name: p.name, downloaded: p.downloaded ?? true, head: enhanced.uuid, versions: [original, enhanced] };
      }),
    };
    state.shoots.push(shoot);
    return shoot;
  }

  const expired = (s: FakeShoot) => now().getTime() - Date.parse(s.created_at) > 7 * 86_400_000;
  const shootOf = (idStr: string) => state.shoots.find((s) => String(s.photoshoot_id) === idStr);
  const page = <T,>(items: T[], q: URLSearchParams, key: string, max = 100) => {
    const p = Math.max(0, Number(q.get("page") ?? 0));
    const size = Math.min(max, Math.max(1, Number(q.get("page_size") ?? 50)));
    const pageCount = Math.max(1, Math.ceil(items.length / size));
    return { [key]: items.slice(p * size, p * size + size), total: items.length, page: p, page_size: size, page_count: pageCount };
  };
  const take = (key: string): Scripted | null => {
    const list = state.scripts.get(key);
    return list?.length ? list.shift()! : null;
  };
  const jobView = (j: FakeJob) => ({
    job_id: j.job_id, photoshoot_id: j.photoshoot_id, image_uuid: j.image_uuid, image_version_uuid: j.image_version_uuid,
    transform_name: j.transform_name, transform_version: j.transform_version, status: j.status, status_url: `${API}/v1/transforms/${j.job_id}`,
    submitted_at: j.submitted_at, updated_at: j.updated_at, output_image_version_uuid: j.output_image_version_uuid,
    failure_code: j.failure_code, failure_message: j.failure_message,
  });

  /** Advance one job a step per poll: queued → running → terminal. */
  function advance(j: FakeJob) {
    if (j.status === "succeeded" || j.status === "failed") return;
    j.polls++;
    if (j.polls < state.pollsToFinish) {
      j.status = "running";
      return;
    }
    const shoot = state.shoots.find((s) => s.photoshoot_id === j.photoshoot_id)!;
    const photo = shoot.photos.find((p) => p.image_uuid === j.image_uuid)!;
    j.updated_at = now().toISOString();
    if (j.outcome === "failed") {
      j.status = "failed";
      j.failure_code = "transform_failed";
      j.failure_message = "The edit could not be completed.";
      if (!j.refunded && j.charged) { state.balance += j.charged; j.refunded = true; }
      return;
    }
    j.status = "succeeded";
    if (j.outcome === "noop") {
      j.output_image_version_uuid = null;
      if (!j.refunded && j.charged) { state.balance += j.charged; j.refunded = true; }
      return;
    }
    const v: Version = { uuid: id("ver"), parent: j.image_version_uuid, label: j.transform_name, description: `${j.transform_name} edit` };
    photo.versions.push(v);
    j.output_image_version_uuid = v.uuid;
    if (j.makesHead) photo.head = v.uuid;
  }

  async function handle(url: string, init?: RequestInit): Promise<Response | null> {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith(TOKEN_URL)) {
      const p = new URLSearchParams(String(init?.body ?? ""));
      if (p.get("resource") !== `${API}/v1`) return json(400, { error: "invalid_target", error_description: "resource is required" });
      if ((opts.clientId && p.get("client_id") !== opts.clientId) || (opts.clientSecret && p.get("client_secret") !== opts.clientSecret)) return json(401, { error: "invalid_client" });
      const scopes = (p.get("scope") ?? "").split(/\s+/).filter(Boolean);
      const t = id("tok");
      state.tokens.set(t, scopes);
      return json(200, { access_token: t, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") });
    }
    // Presigned S3 PUTs for asset uploads.
    if (url.startsWith("https://fake-s3.example/") && method === "PUT") {
      const ct = new Headers(init?.headers).get("content-type");
      const body = init?.body as ArrayBuffer | Uint8Array | null;
      state.puts.push({ url, contentType: ct, bytes: body ? (body as Uint8Array).byteLength ?? 0 : 0 });
      return new Response(null, { status: 200 });
    }
    // Presigned download URLs: the bytes of a tiny JPEG stand-in.
    if (url.startsWith("https://fake-s3.example/download/")) {
      const ver = url.slice("https://fake-s3.example/download/".length);
      const bytes = opts.imageBytes?.(ver) ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (!url.startsWith(API)) return null;

    const u = new URL(url);
    const path = u.pathname;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const scopes = state.tokens.get(auth.replace(/^Bearer /, ""));
    if (!scopes) return err(401, "invalid_request", "missing or invalid token");
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      return json(422, { detail: [{ loc: ["body"], msg: "invalid JSON", type: "json_invalid" }] });
    }
    state.calls.push({ method, path, body, scopes });
    const key = `${method} ${path.replace(/\/v1\/transforms\/[^/]+$/, "/v1/transforms/:id").replace(/\/photoshoots\/\d+/, "/photoshoots/:id")}`;
    const scripted = take(key);
    if (scripted && scripted !== "lose-response") return json(scripted.status, { error: scripted.error ?? (scripted.status === 429 ? "rate_limited" : "upstream_unavailable"), error_description: "scripted" }, scripted.retryAfter ? { "retry-after": String(scripted.retryAfter) } : {});
    const needs = (scope: string) => (scopes.includes(scope) ? null : err(403, "insufficient_scope", `needs ${scope}`));

    if (method === "GET" && path === "/v1/me") return json(200, { client_id: opts.clientId ?? "cid", user_id: 7, email: "ops@example.test", scopes, credit_balance: state.balance });
    if (method === "GET" && path === "/v1/credits") return json(200, { user_id: 7, credit_balance: state.balance });
    if (method === "GET" && path === "/v1/capabilities") return json(200, { transforms: opts.transforms.map((t) => ({ version: 1, display_name: t.name, category: "other", description: t.name, requires_mask: false, input_schema: null, looks: null, ...t })) });
    if (method === "GET" && path === "/v1/models") return json(200, { models: opts.models ?? [] });
    if (method === "GET" && path === "/v1/photoshoots") {
      const recent = state.shoots.filter((s) => !expired(s)).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(200, page(recent.map((s) => ({ photoshoot_id: s.photoshoot_id, address: s.address, status: s.status, image_count: s.photos.length, created_at: s.created_at, updated_at: s.created_at })), u.searchParams, "photoshoots"));
    }
    // Oct 14 2026: the hub sends raws by URL (createPhotoshootFromUrls).
    if (method === "POST" && path === "/v1/photoshoots/from-urls") {
      const deny = needs("photoshoots:write");
      if (deny) return deny;
      const files = (body.files as { download_url?: string; filename?: string; kind?: string }[]) ?? [];
      if (typeof body.address !== "string" || !files.length) return json(422, { detail: [{ loc: ["body", "files"], msg: "at least 1 item", type: "too_short" }] });
      for (const f of files) {
        if (!f.download_url || !f.filename) return json(422, { detail: [{ loc: ["body", "files"], msg: "download_url and filename required", type: "missing" }] });
        const host = new URL(f.download_url).hostname;
        if (!/(^|\.)dropbox(usercontent)?\.com$|(^|\.)amazonaws\.com$/.test(host)) return err(400, "invalid_download_url", `host ${host} is not fetched`);
      }
      if (new Set(files.map((f) => f.filename!.toLowerCase())).size !== files.length) return err(400, "duplicate_filename", "filenames must be unique in a shoot");
      const shoot = seedShoot({ address: body.address, photos: [], status: "in_progress" });
      shoot.ingest = { jobId: id("ingest"), files: files.map((f) => ({ download_url: f.download_url!, filename: f.filename!, kind: f.kind ?? "raw" })), committed: false, landAfter: state.intake.landAfter, polls: 0 };
      if (scripted === "lose-response") throw new Error("socket hang up (scripted: created, response lost)");
      return json(200, { job_id: shoot.ingest.jobId, photoshoot_id: shoot.photoshoot_id });
    }
    const m = /^\/v1\/photoshoots\/(\d+)(\/.*)?$/.exec(path);
    if (m) {
      const shoot = shootOf(m[1]);
      if (!shoot) return err(404, "not_found");
      if (expired(shoot)) return err(410, "photoshoot_expired");
      const rest = m[2] ?? "";
      if (method === "POST" && rest === "/commit") {
        const deny = needs("photoshoots:write");
        if (deny) return deny;
        const ing = shoot.ingest;
        if (!ing || body.job_id !== ing.jobId) return err(400, "invalid_job_id", "job_id does not belong to this photoshoot");
        if (ing.committed) return err(409, "conflict", "already committed");
        if (ing.landAfter > 0) { ing.landAfter--; return err(409, "files_not_landed", "the fetch is still landing"); }
        ing.committed = true;
        return json(202, { photoshoot_id: shoot.photoshoot_id, status: "in_progress" });
      }
      if (method === "GET" && rest === "/status" && shoot.ingest) {
        const ing = shoot.ingest;
        if (!ing.committed) return json(200, { photoshoot_id: shoot.photoshoot_id, status: "in_progress", pipeline: "hdr", image_count: 0, awaiting_files: true });
        if (shoot.status === "in_progress" && ++ing.polls >= state.intake.processPolls) {
          if (state.intake.outcome === "failure" && !(state.intake.recoverAfterFailure && ing.polls > state.intake.processPolls)) shoot.status = "failure";
          else {
            // One edited photo per 5-bracket set; a drone frame is its own photo.
            const drone = ing.files.filter((f) => /^dji/i.test(f.filename));
            const brackets = ing.files.filter((f) => !/^dji/i.test(f.filename));
            const names = [...Array.from({ length: Math.round(brackets.length / 5) }, (_, i) => brackets[i * 5].filename.replace(/\.[a-z0-9]+$/i, ".jpg")), ...drone.map((f) => f.filename.replace(/\.[a-z0-9]+$/i, ".jpg"))];
            shoot.photos = names.map((n) => {
              const original: Version = { uuid: id("ver"), parent: null, label: "Original", description: null };
              const enhanced: Version = { uuid: id("ver"), parent: original.uuid, label: "Enhanced", description: "HDR enhancement" };
              return { image_uuid: id("img"), name: n, downloaded: false, head: enhanced.uuid, versions: [original, enhanced] };
            });
            shoot.status = "success";
          }
        } else if (shoot.status === "failure" && state.intake.recoverAfterFailure) {
          state.intake.outcome = "success";
          shoot.status = "in_progress";
        }
        return json(200, { photoshoot_id: shoot.photoshoot_id, status: shoot.status, pipeline: "hdr", image_count: shoot.photos.length, awaiting_files: false });
      }
      if (method === "GET" && rest === "/status") return json(200, { photoshoot_id: shoot.photoshoot_id, status: shoot.status, pipeline: "hdr", image_count: shoot.photos.length, awaiting_files: false });
      if (method === "GET" && rest === "/photos") return json(200, { photoshoot_id: shoot.photoshoot_id, ...page(shoot.photos.map((p) => ({ image_uuid: p.image_uuid, image_version_uuid: p.head, name: p.name, downloaded: p.downloaded })), u.searchParams, "photos") });
      if (method === "POST" && rest === "/photos/download") {
        const deny = needs("photoshoots:write");
        if (deny) return deny;
        const images = (body.images as { image_uuid: string; filename?: string }[]) ?? [];
        const photos = images.map((i) => shoot.photos.find((p) => p.image_uuid === i.image_uuid));
        if (photos.some((p) => !p)) return err(404, "not_found");
        const cost = photos.filter((p) => !p!.downloaded).length;
        if (cost > state.balance) return err(402, "insufficient_credits");
        state.balance -= cost;
        photos.forEach((p) => (p!.downloaded = true));
        return json(200, { photoshoot_id: shoot.photoshoot_id, credits_charged: cost, downloads: photos.map((p) => ({ image_uuid: p!.image_uuid, filename: p!.name.replace(/\.[a-z0-9]+$/i, ".jpg"), url: `https://fake-s3.example/download/${p!.head}`, byte_size: 4 })) });
      }
      const pm = /^\/photos\/([^/]+)\/(history|version|describe)$/.exec(rest);
      if (pm) {
        const photo = shoot.photos.find((p) => p.image_uuid === pm[1]);
        if (!photo) return err(404, "not_found");
        if (pm[2] === "history" && method === "GET") return json(200, { steps: photo.versions.map((v) => ({ image_version_uuid: v.uuid, parent_image_version_uuid: v.parent, is_head: v.uuid === photo.head, label: v.label, description: v.description })) });
        if (pm[2] === "version" && method === "POST") {
          const deny = needs("photoshoots:write");
          if (deny) return deny;
          if (!photo.versions.some((v) => v.uuid === body.image_version_uuid)) return err(404, "not_found");
          photo.head = String(body.image_version_uuid);
          return json(200, { photoshoot_id: shoot.photoshoot_id, image_uuid: photo.image_uuid, image_version_uuid: photo.head });
        }
        if (pm[2] === "describe" && method === "POST") return json(200, { photoshoot_id: shoot.photoshoot_id, image_uuid: photo.image_uuid, image_version_uuid: photo.head, description: state.describe ? state.describe(photo.name, String(body.prompt ?? "")) : "A room." });
      }
      if (method === "POST" && rest === "/asset-uploads") {
        const deny = needs("images:edit");
        if (deny) return deny;
        const kind = (body.kind as "mask" | "reference" | undefined) ?? "reference";
        const files = (body.files as { filename: string; content_type?: string }[]) ?? [];
        if (!files.length) return json(422, { detail: [{ loc: ["body", "files"], msg: "at least 1 item", type: "too_short" }] });
        const uploads = files.map((f) => {
          const s3 = `s3://fake-bucket/${shoot.photoshoot_id}/${id("asset")}/${f.filename}`;
          shoot.assets.set(s3, kind);
          return { filename: f.filename, url: `https://fake-s3.example/put/${encodeURIComponent(s3)}`, s3_url: s3 };
        });
        return json(201, { uploads });
      }
      return err(404, "not_found");
    }
    if (method === "POST" && path === "/v1/transforms") {
      const deny = needs("images:edit");
      if (deny) return deny;
      const allowed = ["photoshoot_id", "image_uuid", "image_version_uuid", "transform_name", "transform_version", "prompt", "model_id", "mask_url", "reference_image_urls", "params"];
      const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
      if (unknown.length) return json(422, { detail: unknown.map((k) => ({ loc: ["body", k], msg: "Extra inputs are not permitted", type: "extra_forbidden" })) });
      const shoot = state.shoots.find((s) => s.photoshoot_id === body.photoshoot_id);
      if (!shoot) return err(404, "not_found");
      if (expired(shoot)) return err(410, "photoshoot_expired");
      const photo = shoot.photos.find((p) => p.image_uuid === body.image_uuid);
      if (!photo || !photo.versions.some((v) => v.uuid === body.image_version_uuid)) return err(404, "not_found");
      const cap = opts.transforms.find((t) => t.name === body.transform_name);
      if (!cap) return err(403, "transform_not_exposed");
      if (cap.requires_mask) {
        if (!body.mask_url) return err(400, "mask_required");
        const kind = shoot.assets.get(String(body.mask_url));
        if (kind !== "mask") return err(400, "invalid_mask_url");
      }
      if (body.transform_name === "reedit" && !body.prompt) return err(400, "prompt_required");
      let price = cap.credit_cost ?? 0;
      if (body.transform_name === "style") {
        const model = (opts.models ?? []).find((mm) => mm.id === body.model_id);
        if (!model) return err(400, "model_id_required");
        price = model.style_credit_cost;
      }
      if (price > state.balance) return err(402, "insufficient_credits");
      state.balance -= price; // charged on submit
      const j: FakeJob = {
        job_id: id("job"), photoshoot_id: shoot.photoshoot_id, image_uuid: photo.image_uuid, image_version_uuid: String(body.image_version_uuid),
        transform_name: String(body.transform_name), transform_version: Number(body.transform_version ?? 1), status: "queued",
        submitted_at: now().toISOString(), updated_at: now().toISOString(), output_image_version_uuid: null, failure_code: null, failure_message: null,
        charged: price, refunded: false, makesHead: body.transform_name !== "style" && body.image_version_uuid === photo.head, outcome: state.nextOutcome ?? "succeeded", polls: 0,
      };
      state.nextOutcome = null;
      state.jobs.push(j);
      if (scripted === "lose-response") throw new Error("socket hang up (scripted: processed, response lost)");
      return json(202, jobView(j));
    }
    if (method === "GET" && path === "/v1/transforms") {
      const sid = Number(u.searchParams.get("photoshoot_id"));
      const st = u.searchParams.get("state") ?? "active";
      const jobs = state.jobs
        .filter((j) => j.photoshoot_id === sid)
        .filter((j) => st === "all" || (st === "active" ? j.status === "queued" || j.status === "running" : j.status === "succeeded" || j.status === "failed"))
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
      return json(200, page(jobs.map(jobView), u.searchParams, "jobs"));
    }
    const jm = /^\/v1\/transforms\/([^/]+)$/.exec(path);
    if (jm && method === "GET") {
      const j = state.jobs.find((x) => x.job_id === jm[1]);
      if (!j) return err(404, "not_found");
      advance(j);
      return json(200, jobView(j));
    }
    return err(404, "not_found");
  }

  return {
    handle,
    state,
    seedShoot,
    script(key: string, s: Scripted) {
      state.scripts.set(key, [...(state.scripts.get(key) ?? []), s]);
    },
    setNextOutcome(o: "succeeded" | "failed" | "noop") {
      state.nextOutcome = o;
    },
    /** The version chain of a photo (to map a version back to its photo in drills). */
    photoOfVersion(versionUuid: string) {
      for (const sh of state.shoots) for (const p of sh.photos) if (p.versions.some((v) => v.uuid === versionUuid)) return p;
      return null;
    },
    /** POSTs that reached AutoHDR, by path. */
    posts(pathPrefix: string) {
      return state.calls.filter((c) => c.method === "POST" && c.path.startsWith(pathPrefix));
    },
  };
}

export type FakeAutohdr = ReturnType<typeof createFakeAutohdr>;
