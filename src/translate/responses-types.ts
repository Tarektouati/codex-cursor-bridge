/**
 * The subset of the OpenAI Responses API wire format that Codex CLI 0.140
 * actually produces and consumes. Field names follow the API, not our taste,
 * because Codex deserializes them strictly.
 */

export interface ContentItem {
  type: "input_text" | "output_text" | "input_image";
  text?: string;
  image_url?: string;
}

export interface MessageItem {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: ContentItem[];
  phase?: string;
}

export interface FunctionCallItem {
  type: "function_call";
  name: string;
  /** JSON-encoded string, not an object. */
  arguments: string;
  call_id: string;
  id?: string;
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: unknown;
}

export interface CustomToolCallItem {
  type: "custom_tool_call";
  name: string;
  /** Raw string payload for freeform/grammar tools. */
  input: string;
  call_id: string;
  id?: string;
}

export interface CustomToolCallOutputItem {
  type: "custom_tool_call_output";
  call_id: string;
  output: unknown;
}

export interface ReasoningItem {
  type: "reasoning";
  summary?: Array<{ type: "summary_text"; text: string }>;
  content?: Array<{ type: "reasoning_text"; text: string }>;
  encrypted_content?: string;
}

export type ResponseItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | CustomToolCallItem
  | CustomToolCallOutputItem
  | ReasoningItem
  | { type: string; [key: string]: unknown };

/** A tool definition as Codex serializes it. */
export type CodexTool =
  | {
      type: "function";
      name: string;
      description?: string;
      strict?: boolean;
      parameters?: Record<string, unknown>;
    }
  | {
      type: "custom";
      name: string;
      description?: string;
      format?: Record<string, unknown>;
    }
  | {
      type: "namespace";
      name: string;
      description?: string;
      tools?: CodexTool[];
    }
  | { type: string; name?: string; [key: string]: unknown };

export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: ResponseItem[] | string;
  tools?: CodexTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  store?: boolean;
  stream?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  reasoning?: unknown;
  text?: unknown;
  client_metadata?: Record<string, string>;
}

/**
 * Codex parses `usage` with non-optional token counts, so a partial object
 * fails the whole `response.completed` frame and turns a good turn into an
 * error. Either send all three or send nothing.
 */
export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}
