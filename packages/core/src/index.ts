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
export const stepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().min(1) }),
  z.object({ action: z.literal('click'), role: z.enum(['button', 'link', 'checkbox']).default('button'), name: z.string().min(1) }),
  z.object({ action: z.literal('fill'), label: z.string().min(1), value: z.string().optional(), env: z.string().optional() }).refine(s => Boolean(s.env) !== (s.value !== undefined), 'Provide value or an environment variable reference'),
  z.object({ action: z.literal('assertText'), text: z.string().min(1) }),
  z.object({ action: z.literal('reload') }), z.object({ action: z.literal('back') }),
  z.object({ action: z.literal('forward') }),
  z.object({ action: z.literal('select'), label: z.string().min(1), value: z.string().min(1) }),
  z.object({ action: z.literal('check'), label: z.string().min(1), checked: z.boolean() }),
]);
export const flowSchema = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).default(''), steps: z.array(stepSchema).min(1).max(100) });
export const configSchema = z.object({
  environment: z.enum(['local', 'test', 'staging']).default('local'), allowedOrigins: z.array(z.url()).default([]),
  modules: z.array(z.enum(['time-machine', 'tasks', 'api', 'payments', 'drift', 'why', 'risk', 'context'])).default(['time-machine', 'tasks', 'drift', 'why', 'risk', 'context']),
  understanding: understandingSchema.default(() => understandingSchema.parse({})),
  ignorePaths: z.array(z.string().min(1)).default([]),
  reliability: reliabilityConfigSchema.default(() => reliabilityConfigSchema.parse({})),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  execution: z.object({ timeoutMs: z.number().int().min(1000).max(1800000).default(120000) }).default(() => ({ timeoutMs: 120000 })),
  auth: z.object({ storageStateEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i).optional(), loginFlow: flowSchema.refine(f => f.steps.every(s => s.action !== 'fill' || Boolean(s.env)), 'Login inputs must use environment references').optional() }).default({}),
  captureBodies: z.boolean().default(false), ignoreUrls: z.array(z.string()).default([]),
  redactFields: z.array(z.string()).default([]), maskSelectors: z.array(z.string()).default([]),
  commands: z.record(z.string(), z.string()).default({}), retentionDays: z.number().int().min(1).max(3650).default(30),
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
