import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import type { TransportContext, TransportName } from "../transport/types.js";
import { createAttachTool, type UploadFunction } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createProfileTool, type ProfileRuntime } from "./profile.js";
import { createQuestionTool, type QuestionRuntime } from "./question.js";
import { createReactTool, type ReactRuntime } from "./react.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createMomTools(
	transport: TransportName,
	executor: Executor,
	getUploadFunction: () => UploadFunction | null,
	getCtx: () => TransportContext | null,
	getProfileRuntime: () => ProfileRuntime | null,
	getReactRuntime: () => ReactRuntime | null,
	getQuestionRuntime: () => QuestionRuntime | null,
): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createAttachTool(getUploadFunction),
		createProfileTool(getCtx, getProfileRuntime),
		createReactTool(getCtx, getReactRuntime),
	];

	if (transport === "discord") {
		tools.push(createQuestionTool(getCtx, getQuestionRuntime));
	}

	return tools;
}
