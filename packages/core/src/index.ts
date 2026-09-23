import { z } from 'zod';
import { reliabilityConfigSchema, type ScenarioDefinition, type ScenarioResult } from './reliability.ts';
import { understandingSchema, type SourceLink } from './understanding.ts';
export const modules = [
  { id: 'time-machine', name: 'Bug Time Machine', description: 'Record, inspect, and replay browser flows.', phase: 1 },
  { id: 'tasks', name: 'Workspace Launcher', description: 'Your files, URLs, and commands in one place.', phase: 1 },
  { id: 'payments', name: 'Payment Stress Lab', description: 'Test the edges of your checkout.', phase: 2 },
  { id: 'api', name: 'API Contract Ambush', description: 'Find what happy-path responses hide.', phase: 2 },
  { id: 'drift', name: 'Design Drift Detector', description: 'Find the details that drift from your tokens.', phase: 3 },
  { id: 'why', name: 'Why Is This Here?', description: 'Connect an element to its source.', phase: 3 },
  { id: 'risk', name: 'PR Risk Map', description: 'Understand the reach of a change.', phase: 3 },
  { id: 'context', name: 'Context Resurrection', description: 'Pick up exactly where you left off.', phase: 4 },
] as const;
const scope = { exact: z.boolean().optional(), tab: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/).optional(), frames: z.array(z.string().min(1).max(300)).max(5).optional() };
const inputValue = { value: z.string().optional(), env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i).optional() };
export const stepSchema = z.discriminatedUnion('action', [
  z.object({ ...scope, action: z.literal('goto'), url: z.string().min(1) }),
  z.object({ ...scope, action: z.literal('click'), role: z.enum(['button', 'link', 'checkbox']).default('button'), name: z.string().min(1) }),
  z.object({ ...scope, action: z.literal('fill'), label: z.string().min(1), ...inputValue }),
  z.object({ ...scope, action: z.literal('assertText'), text: z.string().min(1) }),
  z.object({ ...scope, action: z.literal('reload') }), z.object({ ...scope, action: z.literal('back') }),
  z.object({ ...scope, action: z.literal('forward') }),
  z.object({ ...scope, action: z.literal('select'), selector: z.string().min(1).max(500).optional(), label: z.string().min(1), ...inputValue }),
  z.object({ ...scope, action: z.literal('check'), label: z.string().min(1), checked: z.boolean() }),
  z.object({ ...scope, action: z.literal('upload'), label: z.string().min(1), env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i) }),
  z.object({ ...scope, action: z.literal('newTab'), name: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/), url: z.string().min(1) }),
  z.object({ ...scope, action: z.literal('switchTab'), name: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/) }),
  z.object({ ...scope, action: z.literal('closeTab') }),
  z.object({ ...scope, action: z.literal('popup'), role: z.enum(['button', 'link']).default('link'), name: z.string().min(1), popupTab: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/) }),
]).superRefine((step, ctx) => {
  if ((step.action === 'fill' || step.action === 'select') && Boolean(step.env) === (step.value !== undefined)) ctx.addIssue({ code: 'custom', message: 'Provide value or an environment variable reference' });
});
export const flowSchema = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).default(''), steps: z.array(stepSchema).min(1).max(100) });
export const configSchema = z.object({
  environment: z.enum(['local', 'test', 'staging']).default('local'), allowedOrigins: z.array(z.url()).default([]),
  modules: z.array(z.enum(['time-machine', 'tasks', 'api', 'payments', 'drift', 'why', 'risk', 'context'])).default(['time-machine', 'tasks', 'drift', 'why', 'risk', 'context']),
  understanding: understandingSchema.default(() => understandingSchema.parse({})),
  ignorePaths: z.array(z.string().min(1)).default([]),
  reliability: reliabilityConfigSchema.default(() => reliabilityConfigSchema.parse({})),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  execution: z.object({ timeoutMs: z.number().int().min(1000).max(1800000).default(120000) }).default(() => ({ timeoutMs: 120000 })),
  auth: z.object({ storageStateEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i).optional(), loginFlow: flowSchema.refine(f => f.steps.every(s => !['fill', 'select'].includes(s.action) || ('env' in s && Boolean(s.env))), 'Login inputs must use environment references').optional() }).default({}),
  captureBodies: z.boolean().default(false), ignoreUrls: z.array(z.string()).default([]),
  redactFields: z.array(z.string()).default([]), maskSelectors: z.array(z.string()).default([]),
  commands: z.record(z.string(), z.string()).default({}), retentionDays: z.number().int().min(1).max(3650).default(30),
  scheduledCleanup: z.boolean().default(false),
  detectionOverride: z.object({ framework: z.string().min(1).max(80).optional(), packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional() }).default({}),
});
export type Config = z.infer<typeof configSchema>;
export type FlowDefinition = z.infer<typeof flowSchema>;
export type Flow = FlowDefinition & { id: string; projectId: string; createdAt: string };
export type Project = { id: string; name: string; path: string; baseUrl: string; config: Config; detection: { framework: string; packageManager: string; gitRoot: string | null }; createdAt: string };
export type Run = { id: string; ownerPid?: number; scenarioId?: string; projectId: string; flowId: string; name: string; status: 'running' | 'passed' | 'failed' | 'cancelled'; startedAt: string; endedAt?: string; error?: string; baseUrl: string; flow: FlowDefinition; scenario: ScenarioDefinition; result?: ScenarioResult; git: { branch: string; commit: string; dirty: boolean }; browserVersion?: string; gateway?: import('./reliability.ts').StripeEvidence; browser?: 'chromium' | 'firefox' | 'webkit'; replayOf?: string };
export type RunEvent = { id: string; runId: string; at: string; kind: 'action' | 'navigation' | 'console' | 'request' | 'assertion' | 'error' | 'marker'; title: string; data: Record<string, unknown> };
export type Artifact = { id: string; runId: string; projectId: string; path: string; mediaType: string; name: string; hash: string; redacted: boolean };
export type Finding = { id: string; runId?: string; reportId?: string; fingerprint?: string; sources?: SourceLink[]; projectId: string; title: string; expected: string; observed: string; status: 'open' | 'resolved' | 'suppressed'; createdAt: string };
export const taskSchema = z.object({ name: z.string().min(1), files: z.array(z.string()).default([]), urls: z.array(z.url()).default([]), command: z.string().optional(), branch: z.string().default(''), flowId: z.string().optional(), notes: z.string().default('') });
export type Task = z.infer<typeof taskSchema> & { id: string; projectId: string };
