import { z } from 'zod';

export const styleProperties = ['color', 'background-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom', 'gap', 'font-size', 'border-radius'] as const;
export const driftRuleSchema = z.object({ name: z.string().min(1).max(100), selector: z.string().min(1).max(300), property: z.enum(styleProperties), values: z.array(z.string().min(1).max(100)).min(1).max(30), tolerance: z.number().min(0).max(100).default(0) });
export const understandingSchema = z.object({ bridgeEnabled: z.boolean().default(false), reactInspection: z.boolean().default(false), driftRules: z.array(driftRuleSchema).max(50).default([]) });
export type DriftRule = z.infer<typeof driftRuleSchema>;
export type SourceLink = { file: string; line?: number; component?: string; provenance: 'instrumented' | 'static' | 'heuristic'; reason: string };
export type Report = { id: string; projectId: string; kind: 'drift' | 'element' | 'risk'; name: string; createdAt: string; git: unknown; input: unknown; data: any; sources: SourceLink[]; artifactIds: string[] };
export type SessionSnapshot = { id: string; projectId: string; createdAt: string; git: { branch: string; commit: string; dirty: boolean; files: string; commits: string }; note: string; nextStep: string; proposedAction: string; taskId?: string; lastRunId?: string; lastFailedRunId?: string; openFindingIds: string[] };
export type HandoffTarget = { kind: 'project' | 'run' | 'finding' | 'scenario' | 'report' | 'task' | 'session' | 'flow'; id: string };
