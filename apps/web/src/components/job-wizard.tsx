'use client';

import { useState } from 'react';
import { Loader2, Plus, Wand2, X } from 'lucide-react';
import {
  DECODO_COUNTRIES,
  DECODO_STICKY_MINUTES,
  EXTRACT_STRATEGY_HELP,
  PROXY_HELP,
  RENDER_MODE_HELP,
  SCHEDULE_PRESETS,
  buildProxyValue,
  cn,
  defaultScrapeConfig,
  describeProxy,
  fieldErrors,
  newProxySessionId,
  nextRunAt,
  parseProxyValue,
  parseScrapeConfig,
  type ExtractStrategy,
  type ProxyKind,
  type RenderMode,
  type ScrapeConfig,
} from '@webscraper/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { TIME_ZONE_OPTIONS } from '@/lib/timezones';

/**
 * The job wizard.
 *
 * Four steps, but the important design decision is that it is **not** a
 * funnel that hides things: every step writes into one `ScrapeConfig` object
 * that is validated with the same Zod schema the API and the engine use. A user
 * who knows what they want can therefore express it, and a user who does not is
 * walked through it with the help text that ships with the schema.
 *
 * Two affordances worth noting:
 *
 *  - **"Describe it in English"** calls `/api/ai/config`, which returns a
 *    *proposed* config. It is validated before it is applied, and when the model
 *    produces something invalid the wizard shows the exact field that failed
 *    rather than silently discarding it.
 *  - **"Test extraction"** saves the job (as a draft) and fetches a single page
 *    through `/api/jobs/[id]/preview`. A preview that ran before saving would
 *    have nowhere to report its results; a preview that crawled would be a
 *    denial-of-service against the target.
 */

type Step = 1 | 2 | 3 | 4;

interface PreviewRecord {
  records: Array<Record<string, unknown>>;
  extraction?: Record<string, unknown>;
  errorMessage?: string | null;
}

export function JobWizard({ aiAvailable, decodoConfigured = false }: { aiAvailable: boolean; decodoConfigured?: boolean }) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [targetsText, setTargetsText] = useState('');
  const [config, setConfig] = useState<ScrapeConfig>(() => defaultScrapeConfig(['https://example.com']));
  const [scheduleCron, setScheduleCron] = useState<string | null>('0 */6 * * *');
  const [scheduleTz, setScheduleTz] = useState('UTC');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);

  // The proxy lives in `config.fetch.proxy`, but its parts are edited
  // separately: a user picks "Decodo, Germany, sticky for 10 minutes", not a
  // string. `buildProxyValue` is the only thing that writes the stored form.
  const [proxy, setProxy] = useState(() => parseProxyValue(null));

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedJobId, setSavedJobId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewRecord | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [nlPrompt, setNlPrompt] = useState('');
  const [nlBusy, setNlBusy] = useState(false);
  const [nlNote, setNlNote] = useState<string | null>(null);

  const targets = targetsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const upcoming =
    scheduleEnabled && scheduleCron
      ? nextRunAt(scheduleCron, new Date(), scheduleTz)?.toISOString() ?? null
      : null;

  /** Patch a nested slice of the config without losing the rest of it. */
  function update<K extends keyof ScrapeConfig>(key: K, value: Partial<ScrapeConfig[K]>) {
    setConfig((current) => ({ ...current, [key]: { ...(current[key] as object), ...value } }));
  }

  function buildPayload() {
    const candidate = {
      ...config,
      targets,
      mode: config.mode,
      fetch: { ...config.fetch, proxy: buildProxyValue(proxy) },
      ...(config.mode === 'crawl' || config.mode === 'sitemap'
        ? {}
        : { crawl: { ...config.crawl, maxDepth: 0 } }),
    };

    const parsed = parseScrapeConfig(candidate);
    return parsed;
  }

  async function save(mode: 'draft' | 'finish') {
    setErrors({});
    setSaving(true);

    try {
      if (targets.length === 0) {
        setErrors({ targets: 'Add at least one URL to scrape.' });
        setStep(1);
        return;
      }

      let nextConfig: ScrapeConfig;
      try {
        nextConfig = buildPayload();
      } catch (error) {
        // Zod issues are flattened to field paths so the offending input is
        // highlighted instead of showing a wall of text at the top.
        const issues = (error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? [];
        setErrors(Object.fromEntries(issues.slice(0, 8).map((issue) => [issue.path.join('.'), issue.message])));
        return;
      }

      const body = {
        name: name.trim() || 'Untitled job',
        mode: nextConfig.mode,
        config: nextConfig,
        scheduleCron,
        scheduleEnabled: scheduleEnabled && Boolean(scheduleCron),
        tags: [],
      };

      const response = savedJobId
        ? await fetch(`/api/jobs/${savedJobId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: body.name,
              config: body.config,
              scheduleCron: body.scheduleCron,
              scheduleEnabled: body.scheduleEnabled,
            }),
          })
        : await fetch('/api/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });

      const payload = (await response.json().catch(() => ({}))) as {
        job?: { id: string };
        error?: { message?: string; details?: { problems?: Array<{ field: string; message: string }> } };
      };

      if (!response.ok) {
        const problems = payload.error?.details?.problems ?? [];
        setErrors(Object.fromEntries(problems.map((problem) => [problem.field, problem.message])));
        setErrors((current) => ({ ...current, _: payload.error?.message ?? 'The job could not be saved.' }));
        return;
      }

      const jobId = payload.job?.id ?? savedJobId;
      setSavedJobId(jobId ?? null);

      // The time zone lives on the schedule endpoint, so a non-UTC choice is
      // applied in a second call rather than being silently dropped.
      if (jobId && scheduleCron) {
        await fetch(`/api/jobs/${jobId}/schedule`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cron: scheduleCron, tz: scheduleTz, enabled: scheduleEnabled }),
        });
      }

      if (mode === 'finish') {
        window.location.href = jobId ? `/jobs/${jobId}` : '/jobs';
      } else {
        setStep(3);
      }
    } catch {
      setErrors({ _: 'The request failed. Check your connection and try again.' });
    } finally {
      setSaving(false);
    }
  }

  async function generateFromPrompt() {
    setNlBusy(true);
    setNlNote(null);
    setErrors({});

    try {
      const response = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: nlPrompt, url: targets[0] }),
      });
      const payload = (await response.json()) as {
        valid?: boolean;
        config?: ScrapeConfig | null;
        explanation?: string | null;
        problems?: Array<{ field: string; message: string }>;
        error?: { message?: string };
      };

      if (!response.ok) {
        setNlNote(payload.error?.message ?? 'The model could not be reached.');
        return;
      }
      if (!payload.valid || !payload.config) {
        setNlNote('The model proposed a configuration that did not validate. Adjust the prompt and try again.');
        return;
      }

      setConfig({ ...payload.config, targets: targets.length > 0 ? targets : payload.config.targets });
      setNlNote(payload.explanation ?? 'Configuration applied. Review each step before saving.');
    } catch {
      setNlNote('The request failed.');
    } finally {
      setNlBusy(false);
    }
  }

  async function testExtraction() {
    setPreviewing(true);
    setPreview(null);

    try {
      const jobId = savedJobId ?? (await saveForPreview());
      if (!jobId) return;

      const response = await fetch(`/api/jobs/${jobId}/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: targets[0], draftConfig: config }),
      });
      const payload = (await response.json()) as PreviewRecord & { error?: { message?: string } };

      if (!response.ok) {
        setPreview({ records: [], errorMessage: payload.error?.message ?? 'The preview failed.' });
        return;
      }
      setPreview(payload);
    } catch {
      setPreview({ records: [], errorMessage: 'The preview request failed.' });
    } finally {
      setPreviewing(false);
    }
  }

  async function saveForPreview(): Promise<string | null> {
    await save('draft');
    return savedJobId;
  }

  function updateProxy(patch: Partial<typeof proxy>) {
    setProxy((current) => {
      const next = { ...current, ...patch };
      // Switching to a sticky session mints an id once, so every page of a
      // crawl leaves from the same exit IP instead of bouncing between them.
      if (next.kind === 'decodo' && next.stickyMinutes && !next.session) {
        next.session = newProxySessionId();
      }
      if (!next.stickyMinutes) next.session = null;
      return next;
    });
  }

  function addField() {
    update('extract', {
      strategy: 'selectors',
      fields: [
        ...config.extract.fields,
        // Written out in full: every field carries the schema's defaults, so
        // the object is valid before the user has typed anything.
        {
          name: `field_${config.extract.fields.length + 1}`,
          selector: '',
          selectorType: 'css',
          attribute: null,
          type: 'text',
          transforms: [],
          required: false,
          all: false,
          fallbackSelectors: [],
        },
      ],
    });
  }

  function removeField(index: number) {
    update('extract', { fields: config.extract.fields.filter((_, position) => position !== index) });
  }

  function setField(index: number, patch: Partial<ScrapeConfig['extract']['fields'][number]>) {
    update('extract', {
      fields: config.extract.fields.map((field, position) => (position === index ? { ...field, ...patch } : field)),
    });
  }

  const steps: Array<{ id: Step; label: string }> = [
    { id: 1, label: 'Target' },
    { id: 2, label: 'Fetch' },
    { id: 3, label: 'Extract' },
    { id: 4, label: 'Schedule' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">New job</h1>
          <p className="text-xs text-muted-foreground">
            Step {step} of 4 · {steps[step - 1]?.label}
          </p>
        </div>
        <ol className="flex items-center gap-1.5 text-[11px]">
          {steps.map(({ id, label }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => setStep(id)}
                className={cn(
                  'rounded-full border px-2.5 py-1 transition-colors',
                  id === step
                    ? 'border-primary bg-primary/10 text-primary'
                    : id < step
                      ? 'border-border text-foreground'
                      : 'border-border text-muted-foreground',
                )}
              >
                {id}. {label}
              </button>
            </li>
          ))}
        </ol>
      </div>

      {errors._ ? (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger" role="alert">
          {errors._}
        </p>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>What should be scraped?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Job name" htmlFor="job-name" error={errors.name}>
              <Input
                id="job-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Competitor pricing watch"
                maxLength={200}
              />
            </Field>

            <Field
              label="Target URLs"
              htmlFor="job-targets"
              hint="One per line. Every URL is checked against the egress policy before the job is saved."
              error={errors.targets ?? errors['targets.0'] ?? errors.config}
            >
              <Textarea
                id="job-targets"
                value={targetsText}
                onChange={(event) => setTargetsText(event.target.value)}
                placeholder={'https://example.com/products\nhttps://example.com/products?page=2'}
                rows={4}
                spellCheck={false}
              />
            </Field>

            <Field label="Mode" htmlFor="job-mode" hint="Crawl follows links within scope; single fetches only what you listed.">
              <Select
                id="job-mode"
                value={config.mode}
                onChange={(event) => setConfig((current) => ({ ...current, mode: event.target.value as ScrapeConfig['mode'] }))}
              >
                <option value="single">Single page</option>
                <option value="crawl">Crawl (follow links)</option>
                <option value="sitemap">Sitemap</option>
                <option value="batch">Batch (list of URLs)</option>
              </Select>
            </Field>

            {aiAvailable ? (
              <div className="rounded-lg border border-border bg-surface-sunken/60 px-4 py-3">
                <p className="flex items-center gap-2 text-xs font-medium">
                  <Wand2 className="h-3.5 w-3.5 text-primary" strokeWidth={2} />
                  Describe it in English
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  The model proposes a configuration; you review it before anything is saved.
                </p>
                <div className="mt-2 flex gap-2">
                  <Input
                    value={nlPrompt}
                    onChange={(event) => setNlPrompt(event.target.value)}
                    placeholder="Extract product name, price and availability from every product page"
                  />
                  <Button variant="secondary" onClick={generateFromPrompt} disabled={nlBusy || nlPrompt.trim().length < 3}>
                    {nlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    Generate
                  </Button>
                </div>
                {nlNote ? <p className="mt-2 text-[11px] text-muted-foreground text-pretty">{nlNote}</p> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>How should pages be fetched?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Rendering" htmlFor="render" hint={RENDER_MODE_HELP[config.fetch.render]}>
                <Select
                  id="render"
                  value={config.fetch.render}
                  onChange={(event) => update('fetch', { render: event.target.value as RenderMode })}
                >
                  {Object.keys(RENDER_MODE_HELP).map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === 'auto' ? 'Automatic (recommended)' : mode === 'http' ? 'HTTP only' : 'Headless browser'}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Timeout (seconds)" htmlFor="timeout">
                  <Input
                    id="timeout"
                    type="number"
                    min={5}
                    max={180}
                    value={Math.round(config.fetch.timeoutMs / 1000)}
                    onChange={(event) => update('fetch', { timeoutMs: Math.max(5, Number(event.target.value) || 30) * 1000 })}
                  />
                </Field>
                <Field label="Max bytes per page" htmlFor="maxbytes">
                  <Input
                    id="maxbytes"
                    type="number"
                    min={100_000}
                    max={25_000_000}
                    step={100_000}
                    value={config.fetch.maxBytes}
                    onChange={(event) => update('fetch', { maxBytes: Math.max(100_000, Number(event.target.value) || 5_000_000) })}
                  />
                </Field>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Respect robots.txt</p>
                  <p className="text-[11px] text-muted-foreground">
                    On by default. Turning it off is a compliance decision, not a technical one.
                  </p>
                </div>
                <Switch
                  checked={config.fetch.respectRobots}
                  onChange={(next) => update('fetch', { respectRobots: next })}
                  label="Respect robots.txt"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Save HTML</p>
                  <p className="text-[11px] text-muted-foreground">Keeps a copy of the page so a selector can be re-tested later.</p>
                </div>
                <Switch checked={config.fetch.saveHtml} onChange={(next) => update('fetch', { saveHtml: next })} label="Save HTML" />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Screenshots</p>
                  <p className="text-[11px] text-muted-foreground">Only possible with browser rendering.</p>
                </div>
                <Switch
                  checked={config.fetch.screenshot}
                  onChange={(next) => update('fetch', { screenshot: next, render: next ? 'js' : config.fetch.render })}
                  label="Screenshots"
                />
              </div>

              {/* ---------------------------------------------------------------
                  Egress. The three-way choice is the whole feature: "which IP
                  does this site see?" is the first question every blocked scrape
                  asks, and the answer must not require editing a .env by hand.
                 --------------------------------------------------------------- */}
              <div className="space-y-2 rounded-lg border border-border px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium">Proxy</p>
                    <p className="text-[11px] text-muted-foreground">{PROXY_HELP[proxy.kind]}</p>
                  </div>
                  <Badge tone={proxy.kind === 'direct' ? 'neutral' : 'primary'}>
                    {describeProxy(buildProxyValue(proxy)).label}
                  </Badge>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {(['direct', 'decodo', 'custom'] as ProxyKind[]).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => updateProxy({ kind })}
                      className={cn(
                        'rounded-full border px-3 py-1 text-[11px] transition-colors',
                        proxy.kind === kind
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-border-strong',
                      )}
                    >
                      {kind === 'direct' ? 'Direct' : kind === 'decodo' ? 'Decodo residential' : 'Custom URL'}
                    </button>
                  ))}
                </div>

                {proxy.kind === 'decodo' ? (
                  <div className="space-y-3 pt-1">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Country" htmlFor="proxy-country">
                        <Select
                          id="proxy-country"
                          value={proxy.country ?? ''}
                          onChange={(event) => updateProxy({ country: event.target.value || null })}
                        >
                          <option value="">Account default</option>
                          {DECODO_COUNTRIES.map((country) => (
                            <option key={country.code} value={country.code}>
                              {country.label} ({country.code.toUpperCase()})
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="IP" htmlFor="proxy-sticky" hint="A sticky session keeps one exit IP for the whole crawl.">
                        <Select
                          id="proxy-sticky"
                          value={proxy.stickyMinutes ? 'sticky' : 'rotate'}
                          onChange={(event) =>
                            updateProxy({ stickyMinutes: event.target.value === 'sticky' ? 10 : null })
                          }
                        >
                          <option value="rotate">Rotate on every request</option>
                          <option value="sticky">Sticky session</option>
                        </Select>
                      </Field>
                    </div>

                    {proxy.stickyMinutes ? (
                      <Field label="Session lifetime" htmlFor="proxy-sticky-minutes">
                        <Select
                          id="proxy-sticky-minutes"
                          value={String(proxy.stickyMinutes)}
                          onChange={(event) => updateProxy({ stickyMinutes: Number(event.target.value) })}
                        >
                          {DECODO_STICKY_MINUTES.map((minutes) => (
                            <option key={minutes} value={minutes}>
                              {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : null}

                    <p className="text-[11px] text-muted-foreground">
                      {decodoConfigured ? (
                        <>
                          Credentials are read from the engine&apos;s environment — this job stores only the targeting.
                        </>
                      ) : (
                        <span className="text-warning">
                          Decodo credentials are not configured on the engine yet. Add DECODO_USERNAME and
                          DECODO_PASSWORD to the root .env and restart it, or this job will fail at fetch time.
                        </span>
                      )}
                    </p>
                  </div>
                ) : null}

                {proxy.kind === 'custom' ? (
                  <Field
                    label="Proxy URL"
                    htmlFor="proxy-custom"
                    hint="http(s):// or socks5://. Anything in the URL — including a password — is stored with the job."
                  >
                    <Input
                      id="proxy-custom"
                      value={proxy.customUrl ?? ''}
                      onChange={(event) => updateProxy({ customUrl: event.target.value })}
                      placeholder="http://user:pass@proxy.internal:3128"
                      spellCheck={false}
                    />
                  </Field>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Crawl scope and politeness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max depth" htmlFor="maxdepth" hint="0 = only the listed pages">
                  <Input
                    id="maxdepth"
                    type="number"
                    min={0}
                    max={6}
                    value={config.crawl.maxDepth}
                    onChange={(event) => update('crawl', { maxDepth: Number(event.target.value) || 0 })}
                  />
                </Field>
                <Field label="Max pages" htmlFor="maxpages">
                  <Input
                    id="maxpages"
                    type="number"
                    min={1}
                    max={5000}
                    value={config.crawl.maxPages}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        crawl: { ...current.crawl, maxPages: Number(event.target.value) || 1 },
                        limits: { ...current.limits, maxPages: Number(event.target.value) || 1 },
                      }))
                    }
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Requests in parallel" htmlFor="concurrency" hint="Per batch, server-side">
                  <Input
                    id="concurrency"
                    type="number"
                    min={1}
                    max={10}
                    value={config.crawl.concurrency}
                    onChange={(event) => update('crawl', { concurrency: Number(event.target.value) || 1 })}
                  />
                </Field>
                <Field label="Delay between batches (ms)" htmlFor="delay">
                  <Input
                    id="delay"
                    type="number"
                    min={0}
                    max={60_000}
                    step={250}
                    value={config.crawl.delayMs}
                    onChange={(event) => update('crawl', { delayMs: Number(event.target.value) || 0 })}
                  />
                </Field>
              </div>

              <Field
                label="Include paths (globs, one per line)"
                htmlFor="include"
                hint="Leave empty for everything in scope. Example: /products/*"
              >
                <Textarea
                  id="include"
                  rows={2}
                  value={config.crawl.include.join('\n')}
                  onChange={(event) => update('crawl', { include: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })}
                  spellCheck={false}
                />
              </Field>

              <Field label="Exclude paths (globs, one per line)" htmlFor="exclude" hint="Example: /cart* or /blog/*">
                <Textarea
                  id="exclude"
                  rows={2}
                  value={config.crawl.exclude.join('\n')}
                  onChange={(event) => update('crawl', { exclude: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })}
                  spellCheck={false}
                />
              </Field>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Stay on the same domain</p>
                  <p className="text-[11px] text-muted-foreground">Strongly recommended; off-domain links are usually nav or ads.</p>
                </div>
                <Switch
                  checked={config.crawl.sameDomain}
                  onChange={(next) => update('crawl', { sameDomain: next })}
                  label="Stay on the same domain"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Follow nofollow links</p>
                  <p className="text-[11px] text-muted-foreground">Off by default; a site owner asked crawlers not to.</p>
                </div>
                <Switch
                  checked={config.crawl.followNofollow}
                  onChange={(next) => update('crawl', { followNofollow: next })}
                  label="Follow nofollow links"
                />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>How should data be extracted?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Strategy" htmlFor="strategy" hint={EXTRACT_STRATEGY_HELP[config.extract.strategy]}>
                <Select
                  id="strategy"
                  value={config.extract.strategy}
                  onChange={(event) => update('extract', { strategy: event.target.value as ExtractStrategy })}
                >
                  {Object.keys(EXTRACT_STRATEGY_HELP).map((strategy) => (
                    <option key={strategy} value={strategy}>
                      {strategy === 'auto'
                        ? 'Automatic (structured data first)'
                        : strategy === 'selectors'
                          ? 'CSS / XPath selectors'
                          : strategy === 'llm'
                            ? 'Language model'
                            : 'Saved recipe'}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Record container (CSS selector)" htmlFor="list" hint="The repeating element that wraps one record, e.g. li.product">
                <Input
                  id="list"
                  value={config.extract.listSelector ?? ''}
                  onChange={(event) => update('extract', { listSelector: event.target.value || null })}
                  placeholder="li.product"
                  spellCheck={false}
                />
              </Field>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">Fields</p>
                  <Button size="sm" variant="secondary" onClick={addField}>
                    <Plus className="h-3.5 w-3.5" />
                    Add field
                  </Button>
                </div>

                {config.extract.fields.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-4 text-[11px] text-muted-foreground">
                    No fields yet. With the automatic strategy you can leave this empty — the engine detects repeating records
                    and infers the shape. Add fields when you need exact control.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {config.extract.fields.map((field, index) => (
                      <div key={index} className="grid grid-cols-[1fr_2fr_auto_auto] items-center gap-2">
                        <Input
                          value={field.name}
                          onChange={(event) => setField(index, { name: event.target.value })}
                          placeholder="name"
                          aria-label="Field name"
                        />
                        <Input
                          value={field.selector ?? ''}
                          onChange={(event) => setField(index, { selector: event.target.value })}
                          placeholder="h2.title"
                          aria-label="CSS selector"
                          spellCheck={false}
                        />
                        <Select
                          value={field.attribute ?? ''}
                          onChange={(event) => setField(index, { attribute: event.target.value || null })}
                          aria-label="Attribute"
                          className="w-28"
                        >
                          <option value="">text</option>
                          <option value="href">href</option>
                          <option value="src">src</option>
                          <option value="content">content</option>
                          <option value="data-price">data-price</option>
                        </Select>
                        <Button size="icon" variant="ghost" onClick={() => removeField(index)} aria-label={`Remove ${field.name}`}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {errors['extract.fields'] ? (
                  <p className="text-xs text-danger" role="alert">
                    {errors['extract.fields']}
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Test extraction</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Saves the job as a draft and fetches one page. Nothing is stored; no links are followed.
                </p>
              </div>
              <Button variant="secondary" onClick={testExtraction} disabled={previewing || targets.length === 0}>
                {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                Test extraction
              </Button>
            </CardHeader>
            <CardContent>
              {preview?.errorMessage ? (
                <p className="text-xs text-danger" role="alert">
                  {preview.errorMessage}
                </p>
              ) : preview ? (
                preview.records.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    The page was fetched but no records were found. Check the container selector, or switch to the automatic
                    strategy.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{preview.records.length} record preview on this page.</p>
                    <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed">
                      {JSON.stringify(preview.records.slice(0, 3), null, 2)}
                    </pre>
                  </div>
                )
              ) : (
                <p className="text-xs text-muted-foreground">
                  Run a test to see the first records this configuration produces.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Schedule</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Frequency" htmlFor="cron">
                <Select
                  id="cron"
                  value={scheduleCron ?? ''}
                  onChange={(event) => {
                    setScheduleCron(event.target.value || null);
                    setScheduleEnabled(Boolean(event.target.value));
                  }}
                >
                  {SCHEDULE_PRESETS.map((preset) => (
                    <option key={preset.label} value={preset.cron ?? ''}>
                      {preset.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Time zone" htmlFor="tz" hint="A daily 09:00 job stays at 09:00 across daylight saving.">
                <Select id="tz" value={scheduleTz} onChange={(event) => setScheduleTz(event.target.value)} disabled={!scheduleCron}>
                  {TIME_ZONE_OPTIONS.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Enabled</p>
                  <p className="text-[11px] text-muted-foreground">
                    {upcoming ? `Next run ${new Date(upcoming).toLocaleString()}` : 'Manual runs only.'}
                  </p>
                </div>
                <Switch
                  checked={scheduleEnabled}
                  onChange={setScheduleEnabled}
                  disabled={!scheduleCron}
                  label="Schedule enabled"
                />
              </div>

              {scheduleEnabled && scheduleCron ? (
                <p className="rounded-lg border border-border bg-surface-sunken/60 px-3 py-2 text-[11px] text-muted-foreground">
                  Scheduled runs need Redis and a running worker. Without them the job is still runnable by hand.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Limits</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max pages per run" htmlFor="limit-pages">
                  <Input
                    id="limit-pages"
                    type="number"
                    min={1}
                    max={5000}
                    value={config.limits.maxPages}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        limits: { ...current.limits, maxPages: Number(event.target.value) || 1 },
                      }))
                    }
                  />
                </Field>
                <Field label="Max duration (minutes)" htmlFor="limit-duration">
                  <Input
                    id="limit-duration"
                    type="number"
                    min={1}
                    max={120}
                    value={Math.round(config.limits.maxDurationMs / 60_000)}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        limits: { ...current.limits, maxDurationMs: (Number(event.target.value) || 5) * 60_000 },
                      }))
                    }
                  />
                </Field>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium">Summary</p>
                <ul className="space-y-1 rounded-lg border border-border bg-surface-sunken/60 px-3 py-2 text-[11px] text-muted-foreground">
                  <li>{targets.length} target{targets.length === 1 ? '' : 's'}</li>
                  <li>mode: {config.mode}{config.mode === 'crawl' ? ` · depth ${config.crawl.maxDepth}` : ''}</li>
                  <li>render: {config.fetch.render} · robots {config.fetch.respectRobots ? 'on' : 'OFF'}</li>
                  <li>egress: {describeProxy(buildProxyValue(proxy)).label}</li>
                  <li>extract: {config.extract.strategy}{config.extract.fields.length > 0 ? ` · ${config.extract.fields.length} fields` : ''}</li>
                  <li>up to {config.limits.maxPages} pages per run</li>
                </ul>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={config.fetch.respectRobots ? 'success' : 'warning'}>
                  {config.fetch.respectRobots ? 'robots.txt respected' : 'robots.txt ignored'}
                </Badge>
                {config.fetch.render === 'js' ? <Badge tone="warning">browser rendering</Badge> : null}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setStep((current) => (current > 1 ? ((current - 1) as Step) : current))} disabled={step === 1}>
          Back
        </Button>

        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => save('draft')} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save draft
          </Button>
          {step < 4 ? (
            <Button variant="primary" onClick={() => setStep((current) => (current + 1) as Step)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={() => save('finish')} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create job
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
