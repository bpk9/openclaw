import { rm } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../../test/helpers/envelope-timestamp.js";
import type { TelegramInteractiveHandlerContext } from "./interactive-dispatch.js";
import { expectChannelInboundContextContract as expectInboundContextContract } from "./test-support/inbound-context-contract.js";
const {
  answerCallbackQuerySpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getFileSpy,
  getChatSpy,
  getLoadConfigMock,
  getReadChannelAllowFromStoreMock,
  getOnHandler,
  listSkillCommandsForAgents,
  onSpy,
  replySpy,
  resolveExecApprovalSpy,
  sendMessageSpy,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
  wasSentByBot,
} = await import("./bot.create-telegram-bot.test-harness.js");

let loadSessionStore: typeof import("../../../src/config/sessions.js").loadSessionStore;
let createTelegramBotBase: typeof import("./bot.js").createTelegramBot;
let setTelegramBotRuntimeForTest: typeof import("./bot.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const PUZZLE_EMOJI = "\u{1F9E9}";
const CROSS_MARK_EMOJI = "\u{274C}";
const INFO_EMOJI = "\u{2139}\u{FE0F}";
const CHECK_MARK_EMOJI = "\u{2705}";
const THUMBS_UP_EMOJI = "\u{1F44D}";
const FIRE_EMOJI = "\u{1F525}";
const PARTY_EMOJI = "\u{1F389}";
const EYES_EMOJI = "\u{1F440}";
const HEART_EMOJI = "\u{2764}\u{FE0F}";

function createSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function waitForReplyCalls(count: number) {
  const done = createSignal();
  let seen = 0;
  replySpy.mockImplementation(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    seen += 1;
    if (seen >= count) {
      done.resolve();
    }
    return undefined;
  });
  return done.promise;
}

async function loadEnvelopeTimestampHelpers() {
  return await import("../../../test/helpers/envelope-timestamp.js");
}

async function loadInboundContextContract() {
  return await import("./test-support/inbound-context-contract.js");
}

const ORIGINAL_TZ = process.env.TZ;
describe("createTelegramBot", () => {
  beforeAll(async () => {
    ({ loadSessionStore } = await import("../../../src/config/sessions.js"));
    ({ createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
      await import("./bot.js"));
  });
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  beforeEach(() => {
    setMyCommandsSpy.mockClear();
    clearPluginInteractiveHandlers();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  it("blocks callback_query when inline buttons are allowlist-only and sender not authorized", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-2",
        data: "cmd:option_b",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-2");
  });

  it("blocks DM model-selection callbacks for unpaired users when inline buttons are DM-scoped", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-callback-authz-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "dm" },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      readChannelAllowFromStore.mockResolvedValueOnce([]);

      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-authz-bypass-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 19,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-authz-bypass-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("allows callback_query in groups when group policy authorizes the sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-group-1",
        data: "commands_page_2",
        from: { id: 42, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          date: 1736380800,
          message_id: 20,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // The callback should be processed (not silently blocked)
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-1");
  });

  it("clears approval buttons without re-editing callback message text", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-style",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 21,
          text: [
            `${PUZZLE_EMOJI} Yep-needs approval again.`,
            "",
            "Run:",
            "/approve 138e9b8c allow-once",
            "",
            "Pending command:",
            "```shell",
            "npm view diver name version description",
            "```",
          ].join("\n"),
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, replyMarkup] = editMessageReplyMarkupSpy.mock.calls[0] ?? [];
    expect(chatId).toBe(1234);
    expect(messageId).toBe(21);
    expect(replyMarkup).toEqual({ reply_markup: { inline_keyboard: [] } });
    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          telegram: expect.objectContaining({
            execApprovals: expect.objectContaining({
              enabled: true,
              approvers: ["9"],
              target: "dm",
            }),
          }),
        }),
      }),
      approvalId: "138e9b8c",
      decision: "allow-once",
      allowPluginFallback: true,
      senderId: "9",
    });
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-style");
  });

  it("allows approval callbacks when exec approvals are enabled even without generic inlineButtons capability", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: ["vision"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-capability-free",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-capability-free");
  });

  it("resolves plugin approval callbacks through the shared approval resolver", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-approve",
        data: "/approve plugin:138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          telegram: expect.objectContaining({
            execApprovals: expect.objectContaining({
              enabled: true,
              approvers: ["9"],
              target: "dm",
            }),
          }),
        }),
      }),
      approvalId: "plugin:138e9b8c",
      decision: "allow-once",
      allowPluginFallback: true,
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve");
  });

  it("blocks approval callbacks from telegram users who are not exec approvers", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["999"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-blocked",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 22,
          text: "Run: /approve 138e9b8c allow-once",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-blocked");
  });

  it("does not leak raw approval callback errors back into Telegram chat", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("gateway secret detail"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-error",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 25,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toBe(
      `${CROSS_MARK_EMOJI} Failed to submit approval. Please try again or contact an admin.`,
    );
  });

  it("allows exec approval callbacks from target-only Telegram recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-target",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        approvals: expect.objectContaining({
          exec: expect.objectContaining({
            enabled: true,
            mode: "targets",
          }),
        }),
      }),
      approvalId: "138e9b8c",
      decision: "allow-once",
      allowPluginFallback: false,
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-target");
  });

  it("does not allow target-only recipients to use legacy plugin fallback ids", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    replySpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-legacy-plugin-fallback-blocked",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 25,
          text: "Legacy plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        approvals: expect.objectContaining({
          exec: expect.objectContaining({
            enabled: true,
            mode: "targets",
          }),
        }),
      }),
      approvalId: "138e9b8c",
      decision: "allow-once",
      allowPluginFallback: false,
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      `${CROSS_MARK_EMOJI} Failed to submit approval. Please try again or contact an admin.`,
      undefined,
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-legacy-plugin-fallback-blocked");
  });

  it("keeps plugin approval callback buttons for target-only recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: ["vision"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-approve-blocked",
        data: "/approve plugin:138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve-blocked");
  });

  it("edits commands list for pagination callbacks", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-3",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 12,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentIds: ["main"],
    });
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, params] = editMessageTextSpy.mock.calls[0] ?? [];
    expect(chatId).toBe(1234);
    expect(messageId).toBe(12);
    expect(String(text)).toContain(`${INFO_EMOJI} Commands (2/`);
    expect(params).toEqual({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "◀ Prev", callback_data: "commands_page_1:main" },
            { text: "2/5", callback_data: "commands_page_noop:main" },
            { text: "Next ▶", callback_data: "commands_page_3:main" },
          ],
        ],
      },
    });
  });

  it("falls back to default agent for pagination callbacks without agent suffix", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-no-suffix",
        data: "commands_page_2",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 14,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentIds: ["main"],
    });
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks pagination callbacks when allowlist rejects sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-4",
        data: "commands_page_2",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 13,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-4");
  });

  it("routes compact model callbacks by inferring provider", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const modelId = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    const storePath = `/tmp/openclaw-telegram-model-compact-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: `bedrock/${modelId}`,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-compact-1",
          data: `mdl_sel/${modelId}`,
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 14,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("resets overrides when selecting the configured default model", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-default-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "claude-opus-4-6",
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    };

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-default-1",
          data: "mdl_sel_anthropic/claude-opus-4-6",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 16,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-default-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("formats non-default model selection confirmations with Telegram HTML parse mode", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-html-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-html-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 17,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy).toHaveBeenCalledWith(
        1234,
        17,
        `${CHECK_MARK_EMOJI} Model changed to <b>openai/gpt-5.4</b>\n\nThis model will be used for your next message.`,
        expect.objectContaining({ parse_mode: "HTML" }),
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBe("openai");
      expect(entry?.modelOverride).toBe("gpt-5.4");
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-html-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("rejects ambiguous compact model callbacks and returns provider list", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        agents: {
          defaults: {
            model: "anthropic/shared-model",
            models: {
              "anthropic/shared-model": {},
              "openai/shared-model": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-model-compact-2",
        data: "mdl_sel/shared-model",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 15,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
      'Could not resolve model "shared-model".',
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-2");
  });

  it("includes sender identity in group envelope headers", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    const { expectChannelInboundContextContract: expectInboundContextContract } =
      await loadInboundContextContract();
    const { escapeRegExp, formatEnvelopeTimestamp } = await loadEnvelopeTimestampHelpers();
    expectInboundContextContract(payload);
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
  });

  it("uses quote text when a Telegram partial reply is received", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
        },
        quote: {
          text: "summarize this",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting Ada id:9001]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("includes replied image media in inbound context for text replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "what is in this image?",
          date: 1736380800,
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0] as {
        MediaPath?: string;
        MediaPaths?: string[];
        ReplyToBody?: string;
      };
      expect(payload.ReplyToBody).toBe("<media:image>");
      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not fetch reply media for unauthorized DM replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    sendMessageSpy.mockClear();
    readChannelAllowFromStore.mockResolvedValue([]);
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "hey",
        date: 1736380800,
        from: { id: 999, first_name: "Eve" },
        reply_to_message: {
          message_id: 9001,
          photo: [{ file_id: "reply-photo-1" }],
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("defers reply media download until debounce flush", async () => {
    const DEBOUNCE_MS = 4321;
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const replyDelivered = waitForReplyCalls(1);
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "first",
          date: 1736380800,
          message_id: 101,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "second",
          date: 1736380801,
          message_id: 102,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(getFileSpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === DEBOUNCE_MS,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();
      await replyDelivered;

      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("isolates inbound debounce by DM topic thread id", async () => {
    const DEBOUNCE_MS = 4321;
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const repliesDelivered = waitForReplyCalls(2);
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "topic-100",
          date: 1736380800,
          message_id: 201,
          message_thread_id: 100,
          from: { id: 42, first_name: "Ada" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "topic-200",
          date: 1736380801,
          message_id: 202,
          message_thread_id: 200,
          from: { id: 42, first_name: "Ada" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();

      const debounceTimerIndexes = setTimeoutSpy.mock.calls
        .map((call, index) => ({ index, delay: call[1] }))
        .filter((entry) => entry.delay === DEBOUNCE_MS)
        .map((entry) => entry.index);
      expect(debounceTimerIndexes.length).toBeGreaterThanOrEqual(2);

      for (const index of debounceTimerIndexes) {
        clearTimeout(setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>);
      }
      for (const index of debounceTimerIndexes) {
        const flushTimer = setTimeoutSpy.mock.calls[index]?.[0] as (() => unknown) | undefined;
        await flushTimer?.();
      }

      await repliesDelivered;
      const threadIds = replySpy.mock.calls
        .map(
          (call: [unknown, ...unknown[]]) =>
            (call[0] as { MessageThreadId?: number }).MessageThreadId,
        )
        .toSorted((a: number | undefined, b: number | undefined) => (a ?? 0) - (b ?? 0));
      expect(threadIds).toEqual([100, 200]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("handles quote-only replies without reply metadata", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        quote: {
          text: "summarize this",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting unknown sender]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBeUndefined();
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("unknown sender");
  });

  it("uses external_reply quote text for partial replies", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        external_reply: {
          message_id: 9002,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
          quote: {
            text: "summarize this",
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting Ada id:9002]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9002");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("propagates forwarded origin from external_reply targets", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Thoughts?",
        date: 1736380800,
        external_reply: {
          message_id: 9003,
          text: "forwarded text",
          from: { first_name: "Ada" },
          quote: {
            text: "forwarded snippet",
          },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 500,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.ReplyToForwardedFrom).toBe("Bob Smith (@bobsmith)");
    expect(payload.ReplyToForwardedFromType).toBe("user");
    expect(payload.ReplyToForwardedFromId).toBe("999");
    expect(payload.ReplyToForwardedFromUsername).toBe("bobsmith");
    expect(payload.ReplyToForwardedFromTitle).toBe("Bob Smith");
    expect(payload.ReplyToForwardedDate).toBe(500000);
    expect(payload.Body).toContain(
      "[Forwarded from Bob Smith (@bobsmith) at 1970-01-01T00:08:20.000Z]",
    );
  });

  it("redacts forwarded origin inside reply targets when context visibility is allowlist", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          contextVisibility: "allowlist",
          groups: {
            "-1007": {
              requireMention: false,
              allowFrom: ["1"],
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        message_id: 9004,
        chat: { id: -1007, type: "group", title: "Ops" },
        text: "Thoughts?",
        date: 1736380800,
        from: { id: 1, first_name: "Ada", username: "ada", is_bot: false },
        reply_to_message: {
          message_id: 9003,
          text: "forwarded text",
          from: { id: 1, first_name: "Ada", username: "ada", is_bot: false },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 500,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.ReplyToId).toBe("9003");
    expect(payload.ReplyToBody).toBe("forwarded text");
    expect(payload.ReplyToSender).toBe("Ada");
    expect(payload.ReplyToForwardedFrom).toBeUndefined();
    expect(payload.ReplyToForwardedFromType).toBeUndefined();
    expect(payload.ReplyToForwardedFromId).toBeUndefined();
    expect(payload.ReplyToForwardedFromUsername).toBeUndefined();
    expect(payload.ReplyToForwardedDate).toBeUndefined();
    expect(payload.Body).not.toContain("[Forwarded from Bob Smith (@bobsmith)");
  });

  it("accepts group replies to the bot without explicit mention when requireMention is enabled", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { groups: { "*": { requireMention: true } } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops Chat" },
        text: "following up",
        date: 1736380800,
        reply_to_message: {
          message_id: 42,
          text: "original reply",
          from: { id: 999, first_name: "OpenClaw" },
        },
      },
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(true);
  });

  it("inherits group allowlist + requireMention in topics", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              requireMention: false,
              allowFrom: ["123456789"],
              topics: {
                "99": {},
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("prefers topic allowFrom over group allowFrom", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              allowFrom: ["123456789"],
              topics: {
                "99": { allowFrom: ["999999999"] },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(0);
  });

  it("allows group messages for per-group groupPolicy open override (global groupPolicy allowlist)", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks control commands from unauthorized senders in per-group open groups", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "/status",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes plugin-owned callback namespaces before synthetic command fallback", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();
    sendMessageSpy.mockClear();
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: (async ({ respond, callback }: TelegramInteractiveHandlerContext) => {
        await respond.editMessage({
          text: `Handled ${callback.payload}`,
        });
        return { handled: true };
      }) as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-1",
        data: "codexapp:resume:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).toHaveBeenCalledWith(1234, 11, "Handled resume:thread-1", undefined);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes Telegram #General callback payloads as topic 1 when Telegram omits topic metadata", async () => {
    onSpy.mockClear();
    getChatSpy.mockResolvedValue({ id: -100123456789, type: "supergroup", is_forum: true });
    const handler = vi.fn(
      async ({ respond, conversationId, threadId }: TelegramInteractiveHandlerContext) => {
        expect(conversationId).toBe("-100123456789:topic:1");
        expect(threadId).toBe(1);
        await respond.editMessage({
          text: `Handled ${conversationId}`,
        });
        return { handled: true };
      },
    );
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: handler as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-general",
        data: "codexapp:resume:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100123456789, type: "supergroup", title: "Forum Group" },
          date: 1736380800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(getChatSpy).toHaveBeenCalledWith(-100123456789);
    expect(handler).toHaveBeenCalledOnce();
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      -100123456789,
      11,
      "Handled -100123456789:topic:1",
      undefined,
    );
  });
  it("sets command target session key for dm topic commands", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.CommandTargetSessionKey).toBe("agent:main:main:thread:12345:99");
  });

  it("allows native DM commands for paired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(
      sendMessageSpy.mock.calls.some(
        (call) => call[1] === "You are not authorized to use this command.",
      ),
    ).toBe(false);
  });

  it("keeps native DM commands on the startup-resolved config when fresh reads contain SecretRefs", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    const startupConfig = {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing" as const,
          botToken: "resolved-token",
        },
      },
    };

    createTelegramBot({
      token: "tok",
      config: startupConfig,
    });
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks native DM commands for unpaired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce([]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      12345,
      "You are not authorized to use this command.",
      {},
    );
  });

  it("registers message_reaction handler", () => {
    onSpy.mockClear();
    createTelegramBot({ token: "tok" });
    const reactionHandler = onSpy.mock.calls.find((call) => call[0] === "message_reaction");
    expect(reactionHandler).toBeDefined();
  });

  it("enqueues reaction_count fallback with delivery context", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 499 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 41,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 41: ${FIRE_EMOJI}:1`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:1234:41:${FIRE_EMOJI}:1`),
        deliveryContext: {
          channel: "telegram",
          to: "telegram:1234",
          accountId: expect.any(String),
        },
      }),
    );
  });

  it("enqueues reaction_count fallback from camelCase raw envelope", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500,
        messageReactionCount: {
          chat: { id: 4321, type: "private" },
          messageId: 55,
          reaction: [{ customEmojiId: "ce_123", totalCount: 2 }],
        },
      },
      messageReactionCount: {
        reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction count changed on msg 55: custom:ce_123:2",
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:count:4321:55:custom:ce_123:2"),
        deliveryContext: {
          channel: "telegram",
          to: "telegram:4321",
          accountId: expect.any(String),
        },
      }),
    );
  });

  it("enqueues reaction_count fallback with normalized type/emoji aliases", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50001,
        messageReactionCount: {
          chat: { id: 43211, type: "private" },
          messageId: 5511,
          reaction: [
            { type: "customEmoji", customEmoji: "ce_alias", totalCount: "2" },
            { type: "emoji", unicodeEmoji: FIRE_EMOJI, totalCount: 3 },
          ],
        },
      },
      messageReactionCount: {
        reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 5511: custom:ce_alias:2,${FIRE_EMOJI}:3`,
      expect.objectContaining({
        contextKey: expect.stringContaining(
          `telegram:reaction:count:43211:5511:custom:ce_alias:2,${FIRE_EMOJI}:3`,
        ),
      }),
    );
  });

  it("enqueues reaction_count fallback from flattened envelope fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5001,
        messageReactionCount: {
          chatId: "4322",
          chatType: "private",
          messageId: "551",
          reaction: [{ emoji: FIRE_EMOJI, totalCount: 3 }],
        },
      },
      messageReactionCount: {
        reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 551: ${FIRE_EMOJI}:3`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4322:551:${FIRE_EMOJI}:3`),
      }),
    );
  });

  it("enqueues reaction_count fallback from bigint flattened envelope fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5002,
        messageReactionCount: {
          chatId: 4323n,
          chatType: "private",
          messageId: 552n,
          reaction: [{ emoji: PARTY_EMOJI, totalCount: 2 }],
        },
      },
      messageReactionCount: {
        reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 552: ${PARTY_EMOJI}:2`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4323:552:${PARTY_EMOJI}:2`),
      }),
    );
  });

  it("enqueues reaction_count fallback from index-keyed reaction entries", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5003,
        messageReactionCount: {
          chat: { id: 4324, type: "private" },
          message_id: 553,
          reactions: {
            "0": { emoji: FIRE_EMOJI, total_count: "4" },
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 553: ${FIRE_EMOJI}:4`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4324:553:${FIRE_EMOJI}:4`),
      }),
    );
  });

  it("enqueues reaction_count fallback from wrapped reaction entries", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5004,
        messageReactionCount: {
          chat: { id: 4325, type: "private" },
          message_id: 554,
          reactions: [{ reaction: { type: "emoji", unicode_emoji: FIRE_EMOJI }, total_count: "5" }],
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 554: ${FIRE_EMOJI}:5`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4325:554:${FIRE_EMOJI}:5`),
      }),
    );
  });

  it("enqueues reaction_count fallback from nested emoji alias objects", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5005,
        messageReactionCount: {
          chat: { id: 4326, type: "private" },
          message_id: 555,
          reactions: [
            {
              type: "emoji",
              unicode_emoji: { value: FIRE_EMOJI },
              total_count: "6",
            },
          ],
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 555: ${FIRE_EMOJI}:6`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4326:555:${FIRE_EMOJI}:6`),
      }),
    );
  });

  it("enqueues reaction_count fallback from message_reaction_count_update raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50055,
        message_reaction_count_update: {
          chat: { id: 43265, type: "private" },
          message_id: 5555,
          reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 8 }],
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 5555: ${FIRE_EMOJI}:8`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:43265:5555:${FIRE_EMOJI}:8`),
      }),
    );
  });

  it("enqueues reaction_count fallback from message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5006,
        message_reaction_count_event: {
          chat: { id: 4327, type: "private" },
          message_id: 556,
          reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 7 }],
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 556: ${HEART_EMOJI}:7`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:556:${HEART_EMOJI}:7`),
      }),
    );
  });

  it("enqueues reaction_count fallback from MessageReactionCountEvent raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500601,
        MessageReactionCountEvent: {
          chat: { id: 4327, type: "private" },
          message_id: 55601,
          reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 10 }],
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55601: ${HEART_EMOJI}:10`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55601:${HEART_EMOJI}:10`),
      }),
    );
  });

  it("enqueues reaction_count fallback from payload-wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50061,
        payload: {
          message_reaction_count_event: {
            chat: { id: 4327, type: "private" },
            message_id: 5561,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 11 }],
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 5561: ${HEART_EMOJI}:11`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:5561:${HEART_EMOJI}:11`),
      }),
    );
  });

  it("enqueues reaction_count fallback from update-wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500611,
        update: {
          message_reaction_count_event: {
            chat: { id: 4327, type: "private" },
            message_id: 55611,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 12 }],
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55611: ${HEART_EMOJI}:12`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55611:${HEART_EMOJI}:12`),
      }),
    );
  });

  it("enqueues reaction_count fallback from nested update->payload message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500612,
        update: {
          payload: {
            message_reaction_count_event: {
              chat: { id: 4327, type: "private" },
              message_id: 55612,
              reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 13 }],
            },
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55612: ${HEART_EMOJI}:13`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55612:${HEART_EMOJI}:13`),
      }),
    );
  });

  it("enqueues reaction_count fallback from payload-array wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500613,
        payload: [
          {
            message_reaction_count_event: {
              chat: { id: 4327, type: "private" },
              message_id: 55613,
              reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 14 }],
            },
          },
        ],
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55613: ${HEART_EMOJI}:14`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55613:${HEART_EMOJI}:14`),
      }),
    );
  });

  it("enqueues reaction_count fallback from updates-wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500614,
        updates: {
          message_reaction_count_event: {
            chat: { id: 4327, type: "private" },
            message_id: 55614,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 15 }],
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55614: ${HEART_EMOJI}:15`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55614:${HEART_EMOJI}:15`),
      }),
    );
  });

  it("enqueues reaction_count fallback from records-wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500615,
        records: {
          message_reaction_count_event: {
            chat: { id: 4327, type: "private" },
            message_id: 55615,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 16 }],
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55615: ${HEART_EMOJI}:16`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55615:${HEART_EMOJI}:16`),
      }),
    );
  });

  it("enqueues reaction_count fallback from entries-wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500616,
        entries: {
          message_reaction_count_event: {
            chat: { id: 4327, type: "private" },
            message_id: 55616,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 17 }],
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55616: ${HEART_EMOJI}:17`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55616:${HEART_EMOJI}:17`),
      }),
    );
  });

  it("enqueues reaction_count fallback from results-wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500617,
        results: {
          message_reaction_count_event: {
            chat: { id: 4327, type: "private" },
            message_id: 55617,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 18 }],
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55617: ${HEART_EMOJI}:18`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55617:${HEART_EMOJI}:18`),
      }),
    );
  });

  it("enqueues reaction_count fallback from tuple-entry wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500618,
        payload: [
          [
            "message_reaction_count_event",
            {
              chat: { id: 4327, type: "private" },
              message_id: 55618,
              reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 19 }],
            },
          ],
        ],
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55618: ${HEART_EMOJI}:19`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55618:${HEART_EMOJI}:19`),
      }),
    );
  });

  it("enqueues reaction_count fallback from index-keyed tuple-entry wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 500619,
        payload: [{
          0: "message_reaction_count_event",
          1: {
            chat: { id: 4327, type: "private" },
            message_id: 55619,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 20 }],
          },
        }],
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 55619: ${HEART_EMOJI}:20`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4327:55619:${HEART_EMOJI}:20`),
      }),
    );
  });

  it("enqueues reaction_count fallback from message_reaction_count_events raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5007,
        message_reaction_count_events: {
          chat: { id: 4328, type: "private" },
          message_id: 557,
          reactions: [{ type: "emoji", emoji: THUMBS_UP_EMOJI, total_count: 9 }],
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 557: ${THUMBS_UP_EMOJI}:9`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4328:557:${THUMBS_UP_EMOJI}:9`),
      }),
    );
  });

  it("enqueues reaction_count fallback from message_reaction_count_event array raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50072,
        message_reaction_count_event: [
          {
            chat: { id: 4330, type: "private" },
            message_id: 559,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 12 }],
          },
        ],
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 559: ${HEART_EMOJI}:12`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4330:559:${HEART_EMOJI}:12`),
      }),
    );
  });

  it("enqueues reaction_count fallback from index-keyed message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50073,
        message_reaction_count_event: {
          "0": {
            chat: { id: 4331, type: "private" },
            message_id: 560,
            reactions: [{ type: "emoji", emoji: THUMBS_UP_EMOJI, total_count: 13 }],
          },
        },
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 560: ${THUMBS_UP_EMOJI}:13`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4331:560:${THUMBS_UP_EMOJI}:13`),
      }),
    );
  });

  it("enqueues reaction_count fallback from JSON-string wrapped message_reaction_count_event raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50071,
        payload: JSON.stringify({
          message_reaction_count_event: {
            chat: { id: 4329, type: "private" },
            message_id: 558,
            reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 11 }],
          },
        }),
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 558: ${HEART_EMOJI}:11`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4329:558:${HEART_EMOJI}:11`),
      }),
    );
  });

  it("enqueues reaction_count fallback from direct-envelope reaction_counts raw update", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50074,
        chat: { id: 4332, type: "private" },
        message_id: 561,
        reaction_counts: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 14 }],
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 561: ${HEART_EMOJI}:14`,
      expect.objectContaining({
        contextKey: expect.stringContaining(`telegram:reaction:count:4332:561:${HEART_EMOJI}:14`),
      }),
    );
  });

  it("enqueues system event for reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 500 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada", username: "ada_bot" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada (@ada_bot) on msg 42`,
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:1234:42:9"),
      }),
    );
  });

  it.each([
    {
      name: "blocks reaction when dmPolicy is disabled",
      updateId: 510,
      channelConfig: { dmPolicy: "disabled", reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "blocks reaction in pairing mode for non-paired sender (default dmPolicy)",
      updateId: 514,
      channelConfig: { dmPolicy: "pairing", reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "blocks reaction in allowlist mode for unauthorized direct sender",
      updateId: 511,
      channelConfig: {
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        reactionNotifications: "all",
      },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "allows reaction in allowlist mode for authorized direct sender",
      updateId: 512,
      channelConfig: { dmPolicy: "allowlist", allowFrom: ["9"], reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 1,
    },
    {
      name: "blocks reaction in group allowlist mode for unauthorized sender",
      updateId: 513,
      channelConfig: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        groupAllowFrom: ["12345"],
        reactionNotifications: "all",
      },
      reaction: {
        chat: { id: 9999, type: "supergroup" },
        message_id: 77,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
  ])("$name", async ({ updateId, channelConfig, reaction, expectedEnqueueCalls }) => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: channelConfig,
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: updateId },
      messageReaction: reaction,
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(expectedEnqueueCalls);
  });

  it("skips reaction when reactionNotifications is off", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "off" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 501 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("defaults reactionNotifications to own", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 502 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 43,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("allows reaction in all mode regardless of message sender", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 99`,
      expect.any(Object),
    );
  });

  it("falls back to latest emoji when Telegram sends a no-op reaction diff", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5031 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 100,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 100`,
      expect.any(Object),
    );
  });

  it("falls back to the newest emoji when no-op diffs include multiple emoji reactions", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5032 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 101,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [
          { type: "emoji", emoji: THUMBS_UP_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
        new_reaction: [
          { type: "emoji", emoji: THUMBS_UP_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 101`,
      expect.any(Object),
    );
  });

  it("falls back to previous reactions when no-op diffs omit new_reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50321 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1011,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1011`,
      expect.any(Object),
    );
  });

  it("falls back to latest custom emoji when Telegram sends a no-op custom reaction diff", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5033 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 102,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "custom_emoji", custom_emoji_id: "ce_1" }],
        new_reaction: [{ type: "custom_emoji", custom_emoji_id: "ce_1" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: custom_emoji:ce_1 by Ada on msg 102",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with missing old_reaction arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5034 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 103,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 103`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with camelCase reaction arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5035 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 104,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 104`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with camelCase reaction type labels", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50351 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1041,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ type: "customEmoji", customEmojiId: "ce_camel" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: custom_emoji:ce_camel by Ada on msg 1041",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with customEmoji alias fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50352 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1042,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ customEmoji: "ce_alias" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: custom_emoji:ce_alias by Ada on msg 1042",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with nested customEmoji identifier objects", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503520 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10420,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ type: "customEmoji", customEmoji: { id: "ce_nested_alias" } }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: custom_emoji:ce_nested_alias by Ada on msg 10420",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with nested emoji alias objects", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5035201 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 104201,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ type: "emoji", emoji: { value: PARTY_EMOJI } }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 104201`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with custom_emoji alias fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503521 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10421,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ custom_emoji: "ce_alias_snake" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: custom_emoji:ce_alias_snake by Ada on msg 10421",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with emoticon alias fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503522 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10422,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ type: "emoji", emoticon: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10422`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with unicode_emoji alias fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503523 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10423,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ type: "emoji", unicode_emoji: FIRE_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 10423`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with numeric custom emoji identifiers", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50353 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1043,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "custom_emoji", custom_emoji_id: 987654321 }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: custom_emoji:987654321 by Ada on msg 1043",
      expect.any(Object),
    );
  });

  it("uses raw update reaction arrays when parsed reaction omits them", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5036,
        message_reaction: {
          chat: { id: 1234, type: "private" },
          message_id: 105,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 105,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 105`,
      expect.any(Object),
    );
  });

  it("uses raw update envelope fields when parsed reaction omits chat/message/user", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50362,
        message_reaction: {
          chat: { id: 1234, type: "private" },
          message_id: 1052,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
      },
      messageReaction: {
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 1052`,
      expect.any(Object),
    );
  });

  it("uses flattened raw update envelope fields when reaction payload omits nested chat/user", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503621,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "10521",
          userId: "9",
          firstName: "Ada",
          newReaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 10521`,
      expect.any(Object),
    );
  });

  it("uses from alias when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5036215,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "105215",
          from: { id: 9, first_name: "Ada" },
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 105215`,
      expect.any(Object),
    );
  });

  it("uses author alias when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50362155,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "1052155",
          author: { id: 9, first_name: "Ada" },
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1052155`,
      expect.any(Object),
    );
  });

  it("uses author_user alias when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50362156,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "1052156",
          author_user: { id: 9, first_name: "Ada" },
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1052156`,
      expect.any(Object),
    );
  });

  it("uses flattened author_user_id aliases when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50362157,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "1052157",
          author_user_id: "9",
          author_user_username: "ada_flat",
          firstName: "Ada",
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada (@ada_flat) on msg 1052157`,
      expect.any(Object),
    );
  });

  it("uses actor alias when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5036216,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "105216",
          actor: { id: 9, first_name: "Ada" },
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 105216`,
      expect.any(Object),
    );
  });

  it("uses from_user alias when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5036217,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "105217",
          from_user: { id: 9, first_name: "Ada" },
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 105217`,
      expect.any(Object),
    );
  });

  it("uses sender_user alias when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5036218,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "105218",
          sender_user: { id: 9, first_name: "Ada" },
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 105218`,
      expect.any(Object),
    );
  });

  it("uses actor_chat alias when reaction payload omits user field", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5036219,
        messageReaction: {
          chatId: "1234",
          chatType: "private",
          messageId: "105219",
          actor_chat: { id: 99, title: "Anon Admin", username: "anon_admin" },
          newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Anon Admin (@anon_admin) on msg 105219`,
      expect.any(Object),
    );
  });

  it("uses bigint flattened raw update envelope fields when reaction payload omits nested chat/user", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503622,
        messageReaction: {
          chatId: 1234n,
          chatType: "private",
          messageId: 10522n,
          userId: 9n,
          firstName: "Ada",
          newReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
      },
      messageReaction: {
        newReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 10522`,
      expect.any(Object),
    );
  });

  it("uses non-empty raw update reaction arrays when parsed reaction arrays are empty", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50361,
        message_reaction: {
          chat: { id: 1234, type: "private" },
          message_id: 1051,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1051,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 1051`,
      expect.any(Object),
    );
  });

  it("uses raw update reaction arrays when parsed arrays are non-empty but non-normalizable", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50363,
        message_reaction: {
          chat: { id: 1234, type: "private" },
          message_id: 1053,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1053,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji" }],
        new_reaction: [{ type: "emoji" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1053`,
      expect.any(Object),
    );
  });

  it("uses camelCase raw update reaction arrays when parsed reaction omits them", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037,
        messageReaction: {
          chat: { id: 1234, type: "private" },
          message_id: 106,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          oldReaction: [],
          newReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 106`,
      expect.any(Object),
    );
  });

  it("uses message_reaction_update raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503705,
        message_reaction_update: {
          chat: { id: 1234, type: "private" },
          message_id: 10605,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10605,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 10605`,
      expect.any(Object),
    );
  });

  it("uses message_reaction_updated raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371,
        message_reaction_updated: {
          chat: { id: 1234, type: "private" },
          message_id: 1061,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061`,
      expect.any(Object),
    );
  });


  it("uses message_reaction_changed raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503715,
        message_reaction_changed: {
          chat: { id: 1234, type: "private" },
          message_id: 10615,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10615,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 10615`,
      expect.any(Object),
    );
  });

  it("uses message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503716,
        message_reaction_event: {
          chat: { id: 1234, type: "private" },
          message_id: 10616,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10616,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 10616`,
      expect.any(Object),
    );
  });

  it("uses MessageReactionEvent raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371601,
        MessageReactionEvent: {
          chat: { id: 1234, type: "private" },
          message_id: 1061601,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061601,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 1061601`,
      expect.any(Object),
    );
  });

  it("uses payload-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037161,
        payload: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106161,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106161,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106161`,
      expect.any(Object),
    );
  });

  it("uses update-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037162,
        update: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106162,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106162,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106162`,
      expect.any(Object),
    );
  });

  it("uses nested update->payload message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037163,
        update: {
          payload: {
            message_reaction_event: {
              chat: { id: 1234, type: "private" },
              message_id: 106163,
              user: { id: 9, first_name: "Ada" },
              date: 1736380800,
              old_reaction: [],
              new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
            },
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106163,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106163`,
      expect.any(Object),
    );
  });

  it("uses payload-array wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037164,
        payload: [
          {
            message_reaction_event: {
              chat: { id: 1234, type: "private" },
              message_id: 106164,
              user: { id: 9, first_name: "Ada" },
              date: 1736380800,
              old_reaction: [],
              new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
            },
          },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106164,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106164`,
      expect.any(Object),
    );
  });

  it("uses updates-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037165,
        updates: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106165,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106165,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106165`,
      expect.any(Object),
    );
  });

  it("uses records-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037166,
        records: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106166,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106166,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106166`,
      expect.any(Object),
    );
  });

  it("uses entries-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037167,
        entries: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106167,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106167,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106167`,
      expect.any(Object),
    );
  });

  it("uses items-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037168,
        items: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106168,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106168,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106168`,
      expect.any(Object),
    );
  });

  it("uses results-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037169,
        results: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106169,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106169,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106169`,
      expect.any(Object),
    );
  });

  it("uses tuple-entry wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037170,
        payload: [
          [
            "message_reaction_event",
            {
              chat: { id: 1234, type: "private" },
              message_id: 106170,
              user: { id: 9, first_name: "Ada" },
              date: 1736380800,
              old_reaction: [],
              new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
            },
          ],
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106170,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106170`,
      expect.any(Object),
    );
  });

  it("uses index-keyed tuple-entry wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037171,
        payload: [{
          0: "message_reaction_event",
          1: {
            chat: { id: 1234, type: "private" },
            message_id: 106171,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        }],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106171`,
      expect.any(Object),
    );
  });

  it("uses envelope-wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371691,
        envelope: {
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 1061691,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061691,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 1061691`,
      expect.any(Object),
    );
  });

  it("uses nested wrapper-array message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371692,
        envelope: [
          [
            {
              message_reaction_event: {
                chat: { id: 1234, type: "private" },
                message_id: 1061692,
                user: { id: 9, first_name: "Ada" },
                date: 1736380800,
                old_reaction: [],
                new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
              },
            },
          ],
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061692,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 1061692`,
      expect.any(Object),
    );
  });

  it("uses message_reaction_events raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717,
        message_reaction_events: {
          chat: { id: 1234, type: "private" },
          message_id: 10617,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 10617`,
      expect.any(Object),
    );
  });

  it("uses message_reaction_event array raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172,
        message_reaction_event: [
          {
            chat: { id: 1234, type: "private" },
            message_id: 106172,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106172`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope old_reactions/new_reactions raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371725,
        chat: { id: 1234, type: "private" },
        message_id: 1061725,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reactions: [],
        new_reactions: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061725,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 1061725`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope previous/current raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371726,
        chat: { id: 1234, type: "private" },
        message_id: 1061726,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previous: [{ type: "emoji", emoji: FIRE_EMOJI }],
        current: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope oldValue/newValue raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717268,
        chat: { id: 1234, type: "private" },
        message_id: 10617268,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617268,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617268`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope old_value/new_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172681,
        chat: { id: 1234, type: "private" },
        message_id: 106172681,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        new_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172681,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172681`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope previousValue/currentValue raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717269,
        chat: { id: 1234, type: "private" },
        message_id: 10617269,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previousValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        currentValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617269,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617269`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope previous_value/current_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172691,
        chat: { id: 1234, type: "private" },
        message_id: 106172691,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previous_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        current_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172691,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172691`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope before/after raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717260,
        chat: { id: 1234, type: "private" },
        message_id: 10617260,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        before: [{ type: "emoji", emoji: FIRE_EMOJI }],
        after: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617260,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617260`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope before_value/after_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172601,
        chat: { id: 1234, type: "private" },
        message_id: 106172601,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        before_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        after_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172601,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172601`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope from/to raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261,
        chat: { id: 1234, type: "private" },
        message_id: 10617261,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        from_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        to_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope from_value/to_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172611,
        chat: { id: 1234, type: "private" },
        message_id: 106172611,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        from_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        to_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope from_state/to_state raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371726115,
        chat: { id: 1234, type: "private" },
        message_id: 1061726115,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        from_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        to_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726115,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726115`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope before_state/after_state raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261155,
        chat: { id: 1234, type: "private" },
        message_id: 10617261155,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        before_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        after_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261155,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261155`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_before/state_after raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261156,
        chat: { id: 1234, type: "private" },
        message_id: 10617261156,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_before: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_after: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261156,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261156`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_before_reaction/state_after_reaction raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172611560,
        chat: { id: 1234, type: "private" },
        message_id: 106172611560,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_before_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_after_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611560,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611560`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_before_value/state_after_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172611561,
        chat: { id: 1234, type: "private" },
        message_id: 106172611561,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_before_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_after_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611561,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611561`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_previous/state_current raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261159,
        chat: { id: 1234, type: "private" },
        message_id: 10617261159,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_previous: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_current: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261159,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261159`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_previous_value/state_current_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261161,
        chat: { id: 1234, type: "private" },
        message_id: 10617261161,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_previous_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_current_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261161,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261161`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_previous_reaction/state_current_reaction raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261161,
        chat: { id: 1234, type: "private" },
        message_id: 10617261161,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_previous_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_current_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261161,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261161`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prior_reaction/state_latest_reaction raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261163,
        chat: { id: 1234, type: "private" },
        message_id: 10617261163,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prior_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261163,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261163`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_pre_reaction/state_post_reaction raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261164,
        chat: { id: 1234, type: "private" },
        message_id: 10617261164,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pre_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_post_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261164,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261164`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prev_reaction/state_next_reaction raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261165,
        chat: { id: 1234, type: "private" },
        message_id: 10617261165,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prev_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_next_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261165,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261165`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prev/state_next raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261162,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prev: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_next: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prev_value/state_next_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261163,
        chat: { id: 1234, type: "private" },
        message_id: 10617261163,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prev_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_next_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261163,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261163`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prior_value/state_latest_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261169,
        chat: { id: 1234, type: "private" },
        message_id: 10617261169,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prior_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261169,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261169`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_pre/state_post raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261163,
        chat: { id: 1234, type: "private" },
        message_id: 10617261163,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pre: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_post: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261163,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261163`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_pre_value/state_post_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261170,
        chat: { id: 1234, type: "private" },
        message_id: 10617261170,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pre_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_post_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261170,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261170`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prior/state_latest raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261164,
        chat: { id: 1234, type: "private" },
        message_id: 10617261164,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prior: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261164,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261164`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_priors/state_latests raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261168,
        chat: { id: 1234, type: "private" },
        message_id: 10617261168,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_priors: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latests: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261168,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261168`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_old/state_new raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261165,
        chat: { id: 1234, type: "private" },
        message_id: 10617261165,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_old: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_new: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261165,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261165`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_olds/state_news raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261167,
        chat: { id: 1234, type: "private" },
        message_id: 10617261167,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_olds: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_news: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261167,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261167`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_older/state_newer raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261166,
        chat: { id: 1234, type: "private" },
        message_id: 10617261166,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_older: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newer: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261166,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261166`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_from/state_to raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261160,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_from: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_to: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFrom/stateTo raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261161,
        chat: { id: 1234, type: "private" },
        message_id: 10617261161,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFrom: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateTo: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261161,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261161`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_from_reaction/state_to_reaction raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172611615,
        chat: { id: 1234, type: "private" },
        message_id: 106172611615,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_from_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_to_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611615,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611615`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_from_value/state_to_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717261162,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_from_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_to_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope source_state/target_state raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50371726116,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        source_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        target_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope source_value/target_value raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172612,
        chat: { id: 1234, type: "private" },
        message_id: 106172612,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        source_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        target_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172612,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172612`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope source/target raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172613,
        chat: { id: 1234, type: "private" },
        message_id: 106172613,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        source: [{ type: "emoji", emoji: FIRE_EMOJI }],
        target: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172613,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172613`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope origin/destination raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172614,
        chat: { id: 1234, type: "private" },
        message_id: 106172614,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        origin_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        destination_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172614,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172614`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope src/dst raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037172615,
        chat: { id: 1234, type: "private" },
        message_id: 106172615,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        src_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        dst_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172615,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172615`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope prev/next raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717262,
        chat: { id: 1234, type: "private" },
        message_id: 10617262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        prev_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        next_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617262`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope prior/latest raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 503717263,
        chat: { id: 1234, type: "private" },
        message_id: 10617263,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        prior_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        latest_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617263,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617263`,
      expect.any(Object),
    );
  });

  it("uses index-keyed message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037173,
        message_reaction_event: {
          "0": {
            chat: { id: 1234, type: "private" },
            message_id: 106173,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
          },
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106173,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 106173`,
      expect.any(Object),
    );
  });

  it("uses JSON-string wrapped message_reaction_event raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 5037171,
        payload: JSON.stringify({
          message_reaction_event: {
            chat: { id: 1234, type: "private" },
            message_id: 106171,
            user: { id: 9, first_name: "Ada" },
            date: 1736380800,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
          },
        }),
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 106171`,
      expect.any(Object),
    );
  });

  it("uses message_reactions_updated raw update when parsed reaction omits arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: {
        update_id: 50372,
        message_reactions_updated: {
          chat: { id: 1234, type: "private" },
          message_id: 1062,
          user: { id: 9, first_name: "Ada" },
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
        },
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1062,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Ada on msg 1062`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads that omit type but include emoji fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5038 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 107,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ emoji: FIRE_EMOJI }],
        new_reaction: [{ emoji: FIRE_EMOJI }, { custom_emoji_id: "ce_2" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: custom_emoji:ce_2 by Ada on msg 107",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with bare emoji-string reaction entries", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5039 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 108,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [FIRE_EMOJI],
        new_reaction: [FIRE_EMOJI, PARTY_EMOJI],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 108`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with wrapped reaction entries", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ reaction: { type: "emoji", emoji: FIRE_EMOJI } }],
        new_reaction: [
          { reaction: { type: "emoji", emoji: FIRE_EMOJI } },
          { reaction: { type: "emoji", emoji: PARTY_EMOJI } },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with wrapped reaction-array containers", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50401 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1091,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: {
          reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
        new_reaction: {
          reactions: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: PARTY_EMOJI },
          ],
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1091`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with data-wrapped reaction-array containers", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504015 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10915,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: {
          data: [{ type: "emoji", emoji: FIRE_EMOJI }],
        },
        new_reaction: {
          data: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: PARTY_EMOJI },
          ],
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10915`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with JSON-stringified reaction entries", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50402 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1092,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: ['{"type":"emoji","emoji":"🔥"}'],
        new_reaction: ['{"type":"emoji","emoji":"🔥"}', '{"type":"emoji","emoji":"🤩"}'],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: 🤩 by Ada on msg 1092",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with double-encoded JSON-string reaction entries", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [JSON.stringify('{"type":"emoji","emoji":"🔥"}')],
        new_reaction: [
          JSON.stringify('{"type":"emoji","emoji":"🔥"}'),
          JSON.stringify('{"type":"emoji","emoji":"🤩"}'),
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: 🤩 by Ada on msg 10921",
      expect.any(Object),
    );
  });

  it("handles reaction payloads with singleton object reaction arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50401 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1091,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: { type: "emoji", emoji: FIRE_EMOJI },
        new_reaction: { type: "emoji", emoji: PARTY_EMOJI },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1091`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with index-keyed object reaction arrays", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504011 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10911,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: {
          "0": { type: "emoji", emoji: FIRE_EMOJI },
        },
        new_reaction: {
          "0": { type: "emoji", emoji: FIRE_EMOJI },
          "1": { type: "emoji", emoji: PARTY_EMOJI },
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10911`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with pluralized reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504012 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10912,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        new_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10912`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with shorthand old/new array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504013 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10913,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old: [{ type: "emoji", emoji: FIRE_EMOJI }],
        new: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10913`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with before/after reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040135 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109135,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        before_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        after_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109135`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with singular reaction field fallback", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504014 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10914,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        reaction: { type: "emoji", emoji: PARTY_EMOJI },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10914`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with message-wrapped current reaction fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040144 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109144,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        message: {
          reaction: { type: "emoji", emoji: PARTY_EMOJI },
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109144`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with body-wrapped current reaction fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040146 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109146,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        body: {
          reaction: { type: "emoji", emoji: PARTY_EMOJI },
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109146`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with top-level current reaction fields", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040145 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109145,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        type: "emoji",
        emoji: PARTY_EMOJI,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109145`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with previous/current reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504015 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10915,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previous_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        current_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10915`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with oldValue/newValue reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504016 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10916,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10916`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with beforeValue/afterValue reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040165 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109165,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        beforeValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        afterValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109165`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with beforeState/afterState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040166 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109166,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        beforeState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        afterState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109166`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with previousValue/currentValue reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504017 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10917,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previousValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        currentValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10917`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with from/to reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504018 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10918,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        from_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        to_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10918`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with prev/next reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504019 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10919,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        prevValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        nextValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10919`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with previous/current shorthand keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504020 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10920,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previous: [{ type: "emoji", emoji: FIRE_EMOJI }],
        current: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10920`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with previousState/currentState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040205 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109205,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previousState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        currentState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109205`,
      expect.any(Object),
    );
  });


  it("handles reaction payloads with oldState/newState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040206 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109206,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109206`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with prevState/nextState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040207 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109207,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        prevState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        nextState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109207`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with priorState/latestState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040208 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109208,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        priorState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        latestState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109208`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with fromState/toState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040212 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109212,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        fromState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        toState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109212`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with sourceState/targetState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040213 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109213,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        sourceState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        targetState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109213`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with srcState/dstState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040214 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109214,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        srcState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        dstState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109214`,
      expect.any(Object),
    );
  });


  it("handles reaction payloads with leftState/rightState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50402141 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1092141,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        leftState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        rightState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1092141`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with lhsState/rhsState reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50402142 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1092142,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        lhsState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        rhsState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1092142`,
      expect.any(Object),
    );
  });
  it("handles reaction payloads with prior/latest shorthand keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        prior: [{ type: "emoji", emoji: FIRE_EMOJI }],
        latest: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with formerReaction/latterReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021081 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921081,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        formerReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        latterReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921081`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with initialReaction/finalReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021091 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921091,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        initialReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        finalReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921091`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with firstReaction/lastReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021092 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921092,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        firstReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        lastReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921092`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with startReaction/endReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021093 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921093,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        startReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        endReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921093`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with beginReaction/finishReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021094 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921094,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        beginReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        finishReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921094`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with sourceReaction/destinationReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021095 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921095,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        sourceReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        destinationReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921095`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with originReaction/resultReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021096 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921096,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        originReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        resultReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921096`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with priorReaction/latestReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50402109 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1092109,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        priorReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        latestReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1092109`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with preReaction/postReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021097 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921097,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        preReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        postReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921097`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with earlierReaction/laterReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021098 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921098,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        earlierReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        laterReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921098`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with earliestReaction/latestReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021099 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921099,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        earliestReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        latestReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921099`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with nested diff wrappers", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021100 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921100,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        diff: {
          beforeReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          afterReaction: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: PARTY_EMOJI },
          ],
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921100`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with nested changes wrappers", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040211001 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109211001,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        changes: {
          beforeReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          afterReaction: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: PARTY_EMOJI },
          ],
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109211001`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with nested diff prior/latest aliases", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021101 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921101,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        diff: {
          priorReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          latestReaction: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: PARTY_EMOJI },
          ],
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921101`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with nested diff older/newer aliases", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021102 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921102,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        diff: {
          olderReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          newerReaction: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: PARTY_EMOJI },
          ],
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921102`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with nested diff beforeState/afterState aliases", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021103 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921103,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        diff: {
          beforeState: [{ type: "emoji", emoji: FIRE_EMOJI }],
          afterState: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: PARTY_EMOJI },
          ],
        },
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921103`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with pastReaction/futureReaction reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504021100 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10921100,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        pastReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        futureReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10921100`,
      expect.any(Object),
    );
  });

  it("handles reaction payloads with priorValue/latestValue reaction array keys", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040211 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109211,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        priorValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        latestValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 109211`,
      expect.any(Object),
    );
  });

  it("falls back to paid reactions when Telegram sends a no-op paid diff", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5040 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 109,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "paid" }],
        new_reaction: [{ type: "paid" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: paid by Ada on msg 109",
      expect.any(Object),
    );
  });

  it("handles paid reactions when type is omitted but paid flag is present", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5041 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 110,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ is_paid: true }],
        new_reaction: [{ is_paid: true }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: paid by Ada on msg 110",
      expect.any(Object),
    );
  });

  it("handles paid reactions when type uses paidReaction alias", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5042 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 111,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "paidReaction" }],
        new_reaction: [{ type: "paidReaction" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: paid by Ada on msg 111",
      expect.any(Object),
    );
  });

  it("skips reaction in own mode when message is not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("allows reaction in own mode when message is sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("skips reaction from bot users", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Bot", is_bot: true },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("skips reaction removal (only processes added reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        new_reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("enqueues one event per added emoji reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        new_reaction: [
          { type: "emoji", emoji: THUMBS_UP_EMOJI },
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEventSpy.mock.calls.map((call) => call[0])).toEqual([
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 42`,
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 42`,
    ]);
    expect(enqueueSystemEventSpy).toHaveBeenNthCalledWith(
      1,
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 42`,
      expect.objectContaining({
        deliveryContext: {
          channel: "telegram",
          to: "telegram:1234",
          accountId: expect.any(String),
        },
      }),
    );
    expect(enqueueSystemEventSpy).toHaveBeenNthCalledWith(
      2,
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 42`,
      expect.objectContaining({
        deliveryContext: {
          channel: "telegram",
          to: "telegram:1234",
          accountId: expect.any(String),
        },
      }),
    );
  });

  it("routes forum group reactions to the general topic (thread id not available on reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    // MessageReactionUpdated does not include message_thread_id in the Bot API,
    // so forum reactions always route to the general topic (1).
    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 100,
        user: { id: 10, first_name: "Bob", username: "bob_user" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Bob (@bob_user) on msg 100`,
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:100:10"),
        deliveryContext: {
          channel: "telegram",
          to: "telegram:5678:topic:1",
          accountId: expect.any(String),
          threadId: 1,
        },
      }),
    );
  });

  it("uses correct session key for forum group reactions in general topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 506 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 101,
        // No message_thread_id - should default to general topic (1)
        user: { id: 10, first_name: "Bob" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: EYES_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${EYES_EMOJI} by Bob on msg 101`,
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:101:10"),
      }),
    );
  });

  it("uses correct session key for regular group reactions without topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 507 },
      messageReaction: {
        chat: { id: 9999, type: "group" },
        message_id: 200,
        user: { id: 11, first_name: "Charlie" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Charlie on msg 200`,
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:9999"),
        contextKey: expect.stringContaining("telegram:reaction:add:9999:200:11"),
      }),
    );
    // Verify session key does NOT contain :topic:
    const eventOptions = enqueueSystemEventSpy.mock.calls[0]?.[1] as {
      sessionKey?: string;
    };
    const sessionKey = eventOptions.sessionKey ?? "";
    expect(sessionKey).not.toContain(":topic:");
  });

  it("blocks reaction in own mode when cache is warm and message not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 601 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });
});
