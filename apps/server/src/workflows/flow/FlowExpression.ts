import * as Schema from "effect/Schema";

export interface FlowExpressionContext {
  readonly payload: unknown;
  readonly nodes: Readonly<Record<string, unknown>>;
  readonly trigger: { readonly kind: string };
  readonly run: { readonly id: string; readonly workflow: string; readonly version: number };
}

type Token =
  | { readonly type: "identifier"; readonly value: string; readonly pos: number }
  | { readonly type: "string"; readonly value: string; readonly pos: number }
  | { readonly type: "number"; readonly value: number; readonly pos: number }
  | { readonly type: "boolean"; readonly value: boolean; readonly pos: number }
  | { readonly type: "null"; readonly pos: number }
  | { readonly type: "op"; readonly value: string; readonly pos: number }
  | { readonly type: "punct"; readonly value: string; readonly pos: number };

type AstNode =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "path"; readonly segments: ReadonlyArray<string> }
  | { readonly kind: "array"; readonly items: ReadonlyArray<AstNode> }
  | { readonly kind: "not"; readonly operand: AstNode }
  | {
      readonly kind: "binary";
      readonly op: "&&" | "||" | "==" | "!=" | ">" | ">=" | "<" | "<=" | "in";
      readonly left: AstNode;
      readonly right: AstNode;
    };

const ALLOWED_ROOTS = new Set(["payload", "nodes", "trigger", "run"]);
const BANNED_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

export class FlowExpressionError extends Schema.TaggedError<FlowExpressionError>()(
  "FlowExpressionError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

function validateFlowPathSegments(segments: ReadonlyArray<string>, rawPath: string): void {
  if (segments.length === 0) {
    throw new FlowExpressionError({ reason: `表达式路径不能为空: "${rawPath}"` });
  }
  const root = segments[0]!;
  if (!ALLOWED_ROOTS.has(root)) {
    throw new FlowExpressionError({
      reason: `不允许访问根标识 "${root}"（仅允许 payload、nodes、trigger、run）`,
    });
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new FlowExpressionError({ reason: `表达式路径包含空段: "${rawPath}"` });
    }
    if (BANNED_SEGMENTS.has(segment)) {
      throw new FlowExpressionError({ reason: `表达式禁止访问受保护属性 "${segment}"` });
    }
  }
}

function resolveSafeFlowPath(ctx: FlowExpressionContext, segments: ReadonlyArray<string>): unknown {
  if (segments.length === 0) return undefined;
  const root = segments[0]!;
  if (!ALLOWED_ROOTS.has(root)) return undefined;
  let current: unknown =
    root === "payload"
      ? ctx.payload
      : root === "nodes"
        ? ctx.nodes
        : root === "trigger"
          ? ctx.trigger
          : ctx.run;
  for (let index = 1; index < segments.length; index++) {
    const segment = segments[index]!;
    if (BANNED_SEGMENTS.has(segment)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function tokenize(source: string): ReadonlyArray<Token> {
  const tokens: Array<Token> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (source.startsWith("&&", i) || source.startsWith("||", i)) {
      tokens.push({ type: "op", value: source.slice(i, i + 2), pos: i });
      i += 2;
      continue;
    }
    if (
      source.startsWith("==", i) ||
      source.startsWith("!=", i) ||
      source.startsWith(">=", i) ||
      source.startsWith("<=", i)
    ) {
      tokens.push({ type: "op", value: source.slice(i, i + 2), pos: i });
      i += 2;
      continue;
    }
    if (ch === "!" || ch === ">" || ch === "<") {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "," || ch === ".") {
      tokens.push({ type: "punct", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      let value = "";
      let closed = false;
      while (i < source.length) {
        const current = source[i]!;
        if (current === "\\") {
          i++;
          if (i >= source.length) {
            throw new FlowExpressionError({ reason: `字符串字面量在位置 ${start} 未闭合` });
          }
          const esc = source[i]!;
          value +=
            esc === "n"
              ? "\n"
              : esc === "r"
                ? "\r"
                : esc === "t"
                  ? "\t"
                  : esc === "\\" || esc === "'" || esc === '"'
                    ? esc
                    : esc;
          i++;
          continue;
        }
        if (current === quote) {
          closed = true;
          i++;
          break;
        }
        value += current;
        i++;
      }
      if (!closed) {
        throw new FlowExpressionError({ reason: `字符串字面量在位置 ${start} 未闭合` });
      }
      tokens.push({ type: "string", value, pos: start });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const start = i;
      if (ch === "-") i++;
      while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        i++;
        while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      }
      const raw = source.slice(start, i);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new FlowExpressionError({ reason: `无效数字字面量 "${raw}"` });
      }
      tokens.push({ type: "number", value: parsed, pos: start });
      continue;
    }
    if (/[A-Za-z_@]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_@-]/.test(source[i]!)) i++;
      const word = source.slice(start, i);
      if (word === "true") tokens.push({ type: "boolean", value: true, pos: start });
      else if (word === "false") tokens.push({ type: "boolean", value: false, pos: start });
      else if (word === "null") tokens.push({ type: "null", pos: start });
      else if (word === "in") tokens.push({ type: "op", value: "in", pos: start });
      else tokens.push({ type: "identifier", value: word, pos: start });
      continue;
    }
    throw new FlowExpressionError({ reason: `表达式包含不支持的字符 "${ch}"（位置 ${i}）` });
  }
  return tokens;
}

class Parser {
  private readonly tokens: ReadonlyArray<Token>;
  private index = 0;

  constructor(tokens: ReadonlyArray<Token>) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new FlowExpressionError({ reason: "表达式意外结束" });
    this.index++;
    return token;
  }

  private matchOp(value: string): boolean {
    const token = this.peek();
    if (token?.type === "op" && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.type === "punct" && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  parse(): AstNode {
    const node = this.parseOr();
    if (this.index < this.tokens.length) {
      const extra = this.tokens[this.index]!;
      throw new FlowExpressionError({ reason: `表达式在位置 ${extra.pos} 存在多余 token` });
    }
    return node;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.matchOp("||")) {
      left = { kind: "binary", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseComparison();
    while (this.matchOp("&&")) {
      left = { kind: "binary", op: "&&", left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): AstNode {
    let left = this.parseUnary();
    const next = this.peek();
    if (
      next?.type === "op" &&
      (next.value === "==" ||
        next.value === "!=" ||
        next.value === ">" ||
        next.value === ">=" ||
        next.value === "<" ||
        next.value === "<=" ||
        next.value === "in")
    ) {
      this.consume();
      const right = this.parseUnary();
      left = { kind: "binary", op: next.value, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.matchOp("!")) {
      return { kind: "not", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const token = this.peek();
    if (!token) throw new FlowExpressionError({ reason: "表达式意外结束" });

    if (token.type === "string" || token.type === "number" || token.type === "boolean") {
      this.consume();
      return { kind: "literal", value: token.value };
    }
    if (token.type === "null") {
      this.consume();
      return { kind: "literal", value: null };
    }
    if (this.matchPunct("(")) {
      const inner = this.parseOr();
      if (!this.matchPunct(")")) {
        throw new FlowExpressionError({ reason: "表达式缺少右括号 )" });
      }
      return inner;
    }
    if (this.matchPunct("[")) {
      const items: Array<AstNode> = [];
      if (!this.matchPunct("]")) {
        do {
          items.push(this.parseOr());
        } while (this.matchPunct(","));
        if (!this.matchPunct("]")) {
          throw new FlowExpressionError({ reason: "数组字面量缺少右括号 ]" });
        }
      }
      return { kind: "array", items };
    }
    if (token.type === "identifier") {
      this.consume();
      const segments: Array<string> = [token.value];
      while (this.matchPunct(".")) {
        const seg = this.peek();
        if (!seg || (seg.type !== "identifier" && seg.type !== "number")) {
          throw new FlowExpressionError({
            reason: `点号 "." 后必须跟合法字段名（位置 ${token.pos}）`,
          });
        }
        this.consume();
        segments.push(String(seg.value));
      }
      validateFlowPathSegments(segments, segments.join("."));
      return { kind: "path", segments };
    }
    throw new FlowExpressionError({ reason: `表达式在位置 ${token.pos} 出现意外语法` });
  }
}

function evalNode(node: AstNode, ctx: FlowExpressionContext): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "path":
      return resolveSafeFlowPath(ctx, node.segments);
    case "array":
      return node.items.map((item) => evalNode(item, ctx));
    case "not":
      return !evalNode(node.operand, ctx);
    case "binary": {
      if (node.op === "&&") {
        return Boolean(evalNode(node.left, ctx)) && Boolean(evalNode(node.right, ctx));
      }
      if (node.op === "||") {
        return Boolean(evalNode(node.left, ctx)) || Boolean(evalNode(node.right, ctx));
      }
      const left = evalNode(node.left, ctx);
      const right = evalNode(node.right, ctx);
      switch (node.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
          return (
            ((typeof left === "number" && typeof right === "number") ||
              (typeof left === "string" && typeof right === "string")) &&
            left > right
          );
        case ">=":
          return (
            ((typeof left === "number" && typeof right === "number") ||
              (typeof left === "string" && typeof right === "string")) &&
            left >= right
          );
        case "<":
          return (
            ((typeof left === "number" && typeof right === "number") ||
              (typeof left === "string" && typeof right === "string")) &&
            left < right
          );
        case "<=":
          return (
            ((typeof left === "number" && typeof right === "number") ||
              (typeof left === "string" && typeof right === "string")) &&
            left <= right
          );
        case "in":
          if (Array.isArray(right)) return right.some((entry) => entry === left);
          if (typeof right === "string" && typeof left === "string") return right.includes(left);
          return false;
      }
    }
  }
}

export function parseFlowExpression(source: string): AstNode {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new FlowExpressionError({ reason: "条件表达式不能为空" });
  }
  const tokens = tokenize(trimmed);
  return new Parser(tokens).parse();
}

export function evaluateFlowExpression(source: string, ctx: FlowExpressionContext): boolean {
  const ast = parseFlowExpression(source);
  return Boolean(evalNode(ast, ctx));
}

const TEMPLATE_TOKEN_RE = /\{\{([^{}]+)\}\}/g;

export function containsTemplateSyntax(value: string): boolean {
  return /\{\{[^{}]*\}\}/.test(value);
}

export function extractTemplatePaths(template: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const match of template.matchAll(TEMPLATE_TOKEN_RE)) {
    const path = (match[1] ?? "").trim();
    if (path.length > 0 && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export function validateTemplatePaths(template: string): ReadonlyArray<string> {
  const paths = extractTemplatePaths(template);
  for (const path of paths) {
    const segments = path.split(".");
    validateFlowPathSegments(segments, path);
  }
  return paths;
}

function formatTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function escapeUntrustedDataTags(raw: string): string {
  return raw
    .replaceAll(/<\/untrusted_event_data>/gi, "&lt;/untrusted_event_data&gt;")
    .replaceAll(/<untrusted_event_data/gi, "&lt;untrusted_event_data");
}

export function renderFlowTemplate(
  template: string,
  ctx: FlowExpressionContext,
  options: { readonly wrapUntrustedPayload: boolean },
): {
  readonly text: string;
  readonly usedUntrustedPayload: boolean;
  readonly untrustedFields: ReadonlyArray<string>;
} {
  let usedUntrustedPayload = false;
  const untrustedFields: Array<string> = [];
  const seenUntrusted = new Set<string>();

  const text = template.replace(TEMPLATE_TOKEN_RE, (_full, rawExpr: string) => {
    const trimmed = rawExpr.trim();
    const segments = trimmed.split(".");
    validateFlowPathSegments(segments, trimmed);
    const resolved = formatTemplateValue(resolveSafeFlowPath(ctx, segments));
    const isPayloadPath = segments[0] === "payload";
    if (isPayloadPath && options.wrapUntrustedPayload) {
      usedUntrustedPayload = true;
      if (!seenUntrusted.has(trimmed)) {
        seenUntrusted.add(trimmed);
        untrustedFields.push(trimmed);
      }
      return `<untrusted_event_data field="${trimmed}">\n${escapeUntrustedDataTags(resolved)}\n</untrusted_event_data>`;
    }
    return resolved;
  });

  return { text, usedUntrustedPayload, untrustedFields };
}
