import { rm } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinnedHostnameResolution } from "../../../src/test-helpers/ssrf.js";
import type { TelegramInteractiveHandlerContext } from "./interactive-dispatch.js";
const {
  answerCallbackQuerySpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getFileSpy,
  getChatSpy,
  getLoadConfigMock,
  getLoadWebMediaMock,
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
let createTelegramBotBase: typeof import("./bot-core.js").createTelegramBotCore;
let setTelegramBotRuntimeForTest: typeof import("./bot-core.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();
const loadWebMedia = getLoadWebMediaMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const PUZZLE_EMOJI = "\u{1F9E9}";
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
    ({ createTelegramBotCore: createTelegramBotBase, setTelegramBotRuntimeForTest } =
      await import("./bot-core.js"));
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

  it("blocks group model-selection callbacks for senders who are not authorized for /models", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-group-model-authz-${process.pid}-${Date.now()}.json`;

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
        commands: {
          allowFrom: {
            telegram: ["9"],
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "group" },
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
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
          id: "cbq-group-model-authz-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: -100999, type: "supergroup", title: "Test Group" },
            date: 1736380800,
            message_id: 21,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-model-authz-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("recomputes group model-selection callback auth from runtime command config", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-group-model-authz-runtime-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      let currentConfig = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        commands: {
          allowFrom: {
            telegram: ["999"],
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "group" },
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockImplementation(() => currentConfig);
      createTelegramBot({
        token: "tok",
        config: currentConfig,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      currentConfig = {
        ...currentConfig,
        commands: {
          allowFrom: {
            telegram: ["9"],
          },
        },
      };

      await callbackHandler({
        callbackQuery: {
          id: "cbq-group-model-authz-runtime-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: -100999, type: "supergroup", title: "Test Group" },
            date: 1736380800,
            message_id: 22,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-model-authz-runtime-1");
    } finally {
      loadConfig.mockReset();
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

  it("keeps approval callback resolution failures out of Telegram chat before retry", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
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

    await expect(
      callbackHandler({
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
      }),
    ).rejects.toThrow("gateway secret detail");

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-error");
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

  it("keeps legacy plugin fallback approval failures retryable for target-only recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
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

    await expect(
      callbackHandler({
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
      }),
    ).rejects.toThrow("unknown or expired approval id");

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
    expect(sendMessageSpy).not.toHaveBeenCalled();
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

  it("renders model callback lists with configured display names", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as ReturnType<typeof vi.fn>;
    buildModelsProviderDataMock.mockResolvedValueOnce({
      byProvider: new Map<string, Set<string>>([["openai", new Set(["gpt-5", "gpt-4.1"])]]),
      providers: ["openai"],
      resolvedDefault: { provider: "openai", model: "gpt-5" },
      modelNames: new Map<string, string>([
        ["openai/gpt-4.1", "GPT 4.1 Bridge"],
        ["openai/gpt-5", "GPT Five Bridge"],
      ]),
    });

    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    loadConfig.mockReturnValue(config);
    createTelegramBot({
      token: "tok",
      config,
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-model-display-names-1",
        data: "mdl_list_openai_1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [, , , params] = editMessageTextSpy.mock.calls[0] ?? [];
    const buttons = (
      params as {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
        };
      }
    ).reply_markup?.inline_keyboard?.flat();

    expect(buttons).toContainEqual({
      text: "GPT 4.1 Bridge",
      callback_data: "mdl_sel_openai/gpt-4.1",
    });
    const gpt5Button = buttons?.find((button) => button.callback_data === "mdl_sel_openai/gpt-5");
    expect(gpt5Button?.text?.replace(" ✓", "")).toBe("GPT Five Bridge");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-display-names-1");
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

  it("persists non-default model override using fresh config, not stale startup snapshot", async () => {
    // Regression: the callback handler used the startup `cfg` snapshot for
    // store path and default-model resolution.  If the config was reloaded
    // (e.g. default model changed) the override could be written to the wrong
    // store or incorrectly cleared because `isDefaultSelection` was wrong.
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-fresh-cfg-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      // Startup config: default is openai/gpt-5.4
      const startupConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            models: {
              "openai/gpt-5.4": {},
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
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      // Fresh config: default changed to anthropic/claude-opus-4-6
      const freshConfig = {
        ...startupConfig,
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "openai/gpt-5.4": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      };

      // Bot created with startup config; loadConfig now returns fresh config
      loadConfig.mockReturnValue(freshConfig);
      createTelegramBot({
        token: "tok",
        config: startupConfig,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      // User selects openai/gpt-5.4 — was default at startup but NOT default
      // in fresh config.  The override must be persisted.
      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-fresh-cfg-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 20,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      // Override must be persisted (not cleared) because openai/gpt-5.4 is
      // NOT the default in the fresh config.
      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBe("openai");
      expect(entry?.modelOverride).toBe("gpt-5.4");
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

  it("keeps reply linkage while omitting filtered binary reply captions", async () => {
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
          caption: "PK\x00\x03\x04binary",
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Replying to Ada id:9001]");
    expect(payload.Body).not.toContain("PK");
    expect(payload.Body).not.toContain("unsafe reply text omitted");
    expect(payload.ReplyToBody).toBeUndefined();
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("includes replied image media in inbound context for text replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadWebMedia.mockResolvedValueOnce({ path: "/tmp/reply-photo.png", contentType: "image/png" });

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
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
    } finally {
      ssrfMock.mockRestore();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0] as {
      MediaPath?: string;
      MediaPaths?: string[];
      ReplyToBody?: string;
    };
    expect(payload.ReplyToBody).toBe("<media:image>");
    expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(mediaFetch).toHaveBeenCalledTimes(1);
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

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const replyDelivered = waitForReplyCalls(1);
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
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
      expect(mediaFetch).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      ssrfMock.mockRestore();
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

  it("defaults reaction_count notifications to all when reactionTrigger is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionTrigger: true },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 4991 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 44,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 44: ${FIRE_EMOJI}:1`,
      expect.any(Object),
    );
  });

  it("preserves explicit own reaction_count notifications when reactionTrigger is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          reactionTrigger: true,
          reactionNotifications: "own",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 49911 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 441,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("preserves explicit off reaction_count notifications when reactionTrigger is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          reactionTrigger: true,
          reactionNotifications: "off",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 49913 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 443,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("preserves explicit own reaction_count notifications when actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          actions: { reactions: true },
          reactionNotifications: "own",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 49912 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 442,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("preserves explicit off reaction_count notifications when actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          actions: { reactions: true },
          reactionNotifications: "off",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 49914 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 444,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("defaults reaction_count notifications to all when actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", actions: { reactions: true } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 4992 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 45,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 45: ${FIRE_EMOJI}:1`,
      expect.any(Object),
    );
  });

  it("keeps reaction_count notifications at own when reactionTrigger is false even if actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          reactionTrigger: false,
          actions: { reactions: true },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction_count") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 4993 },
      messageReactionCount: {
        chat: { id: 1234, type: "private" },
        message_id: 46,
        date: 1736380800,
        reactions: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 1 }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
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
        payload: [
          {
            0: "message_reaction_count_event",
            1: {
              chat: { id: 4327, type: "private" },
              message_id: 55619,
              reactions: [{ type: "emoji", emoji: HEART_EMOJI, total_count: 20 }],
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
        contextKey: expect.stringContaining(
          `telegram:reaction:count:4328:557:${THUMBS_UP_EMOJI}:9`,
        ),
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
        contextKey: expect.stringContaining(
          `telegram:reaction:count:4331:560:${THUMBS_UP_EMOJI}:13`,
        ),
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

  it("enqueues reaction_count fallback from direct-envelope reaction_count raw update", async () => {
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
        update_id: 500741,
        chat: { id: 43321, type: "private" },
        message_id: 5611,
        reaction_count: [{ type: "emoji", emoji: THUMBS_UP_EMOJI, total_count: 9 }],
      },
      messageReactionCount: {
        reactions: [],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction count changed on msg 5611: ${THUMBS_UP_EMOJI}:9`,
      expect.objectContaining({
        contextKey: expect.stringContaining(
          `telegram:reaction:count:43321:5611:${THUMBS_UP_EMOJI}:9`,
        ),
      }),
    );
  });

  it.each([
    ["reaction", "reaction"],
    ["reactions", "reactions"],
    ["reactionCount", "reactionCount"],
    ["reactionCounts", "reactionCounts"],
  ])(
    "enqueues reaction_count fallback from direct-envelope %s raw update",
    async (
      _label: string,
      reactionKey: "reaction" | "reactions" | "reactionCount" | "reactionCounts",
    ) => {
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
          update_id: 50075,
          chat: { id: 4333, type: "private" },
          message_id: 562,
          [reactionKey]: [{ type: "emoji", emoji: FIRE_EMOJI, total_count: 3 }],
        },
        messageReactionCount: {
          reactions: [],
        },
      });

      expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
        `Telegram reaction count changed on msg 562: ${FIRE_EMOJI}:3`,
        expect.objectContaining({
          contextKey: expect.stringContaining(`telegram:reaction:count:4333:562:${FIRE_EMOJI}:3`),
        }),
      );
    },
  );

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

  it("defaults reactionNotifications to all when reactionTrigger is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionTrigger: true },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5021 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 430,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 430`,
      expect.any(Object),
    );
  });

  it("preserves explicit own reactionNotifications when reactionTrigger is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          reactionTrigger: true,
          reactionNotifications: "own",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50211 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 4301,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("preserves explicit off reactionNotifications when reactionTrigger is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          reactionTrigger: true,
          reactionNotifications: "off",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50213 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 4303,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("preserves explicit own reactionNotifications when actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          actions: { reactions: true },
          reactionNotifications: "own",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50212 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 4302,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("preserves explicit off reactionNotifications when actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          actions: { reactions: true },
          reactionNotifications: "off",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 50214 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 4304,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("defaults reactionNotifications to all when actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", actions: { reactions: true } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5022 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 431,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 431`,
      expect.any(Object),
    );
  });

  it("keeps reactionNotifications at own when reactionTrigger is false even if actions.reactions is enabled", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          reactionTrigger: false,
          actions: { reactions: true },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 5023 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 432,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
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
        payload: [
          {
            0: "message_reaction_event",
            1: {
              chat: { id: 1234, type: "private" },
              message_id: 106171,
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

  it("uses direct-envelope oldReactions/newReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717251,
        chat: { id: 1234, type: "private" },
        message_id: 10617251,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReactions: [],
        newReactions: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617251,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 10617251`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope oldReaction/newReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172511,
        chat: { id: 1234, type: "private" },
        message_id: 106172511,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldReaction: [],
        newReaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172511,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada on msg 106172511`,
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

  it("uses direct-envelope previous_reaction/current_reaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717266,
        chat: { id: 1234, type: "private" },
        message_id: 10617266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previous_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        current_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617266`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope previousReaction/currentReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717267,
        chat: { id: 1234, type: "private" },
        message_id: 10617267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previousReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        currentReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617267`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope previousValues/currentValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717267,
        chat: { id: 1234, type: "private" },
        message_id: 10617267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        previousValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        currentValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617267`,
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

  it("uses direct-envelope oldValues/newValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172689,
        chat: { id: 1234, type: "private" },
        message_id: 106172689,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        oldValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172689,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172689`,
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

  it("uses direct-envelope old_values/new_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172682,
        chat: { id: 1234, type: "private" },
        message_id: 106172682,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        new_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172682,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172682`,
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

  it("uses direct-envelope state_before_state/state_after_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611567,
        chat: { id: 1234, type: "private" },
        message_id: 106172611567,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_before_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_after_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611567,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611567`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeforeState/stateAfterState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611570,
        chat: { id: 1234, type: "private" },
        message_id: 106172611570,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeforeState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfterState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611570,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611570`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_before_states/state_after_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611568,
        chat: { id: 1234, type: "private" },
        message_id: 106172611568,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_before_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_after_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611568,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611568`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeforeStates/stateAfterStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611569,
        chat: { id: 1234, type: "private" },
        message_id: 106172611569,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeforeStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfterStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611569,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611569`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_befores/state_afters raw update when parsed reaction omits arrays", async () => {
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
        state_befores: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_afters: [
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

  it("uses direct-envelope stateBefores/stateAfters raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726115611,
        chat: { id: 1234, type: "private" },
        message_id: 1061726115611,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBefores: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfters: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726115611,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726115611`,
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

  it("uses direct-envelope state_before_reactions/state_after_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726115636,
        chat: { id: 1234, type: "private" },
        message_id: 1061726115636,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_before_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_after_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726115636,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726115636`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeforeReaction/stateAfterReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611562,
        chat: { id: 1234, type: "private" },
        message_id: 106172611562,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeforeReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfterReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611562,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611562`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeforeReactions/stateAfterReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726115635,
        chat: { id: 1234, type: "private" },
        message_id: 1061726115635,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeforeReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfterReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726115635,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726115635`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBefore/stateAfter raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611563,
        chat: { id: 1234, type: "private" },
        message_id: 106172611563,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBefore: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfter: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611563,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611563`,
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

  it("uses direct-envelope state_previous_state/state_current_state raw update when parsed reaction omits arrays", async () => {
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
        state_previous_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_current_state: [
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

  it("uses direct-envelope state_previous_states/state_current_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611602,
        chat: { id: 1234, type: "private" },
        message_id: 106172611602,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_previous_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_current_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611602,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611602`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_previous_reactions/state_current_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611603,
        chat: { id: 1234, type: "private" },
        message_id: 106172611603,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_previous_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_current_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611603,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611603`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePreviousReactions/stateCurrentReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611604,
        chat: { id: 1234, type: "private" },
        message_id: 106172611604,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePreviousReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateCurrentReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611604,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611604`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePreviousStates/stateCurrentStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611605,
        chat: { id: 1234, type: "private" },
        message_id: 106172611605,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePreviousStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateCurrentStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611605,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611605`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePreviousState/stateCurrentState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116051,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116051,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePreviousState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateCurrentState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116051,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116051`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prior_state/state_latest_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611601,
        chat: { id: 1234, type: "private" },
        message_id: 106172611601,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prior_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611601,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611601`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePriorState/stateLatestState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116013,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116013,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePriorState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116013,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116013`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePriorStates/stateLatestStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160131,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160131,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePriorStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160131,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160131`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prior_states/state_latest_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160132,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160132,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prior_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160132,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160132`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earliest_state/state_latest_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116014,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116014,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earliest_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116014,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116014`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarliestState/stateLatestState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160140,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160140,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarliestState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160140,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160140`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earliest_states/state_latest_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160143,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160143,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earliest_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160143,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160143`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarliestStates/stateLatestStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160144,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160144,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarliestStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160144,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160144`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earlier_states/state_later_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160145,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160145,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earlier_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_later_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160145,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160145`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarlierStates/stateLaterStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160146,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160146,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarlierStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLaterStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160146,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160146`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_initial_state/state_final_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116015,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116015,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_initial_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_final_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116015,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116015`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_initial_states/state_final_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160151,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160151,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_initial_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_final_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160151,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160151`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_first_states/state_last_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261160153,
        chat: { id: 1234, type: "private" },
        message_id: 10617261160153,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_first_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_last_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261160153,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261160153`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_first_state/state_last_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116016,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116016,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_first_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_last_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116016,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116016`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earlier_state/state_later_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116017,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116017,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earlier_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_later_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116017,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116017`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarlierState/stateLaterState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116018,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116018,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarlierState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLaterState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116018,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116018`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarlierReaction/stateLaterReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116019,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116019,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarlierReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLaterReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116019,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116019`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarlierReactions/stateLaterReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116020,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116020,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarlierReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLaterReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116020,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116020`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_former_state/state_latter_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611602,
        chat: { id: 1234, type: "private" },
        message_id: 106172611602,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_former_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latter_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611602,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611602`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFormerState/stateLatterState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116021,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116021,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFormerState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatterState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116021,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116021`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateInitialState/stateFinalState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116022,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116022,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateInitialState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateFinalState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116022,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116022`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateInitialStates/stateFinalStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116023,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116023,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateInitialStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateFinalStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116023,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116023`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prev_state/state_next_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611603,
        chat: { id: 1234, type: "private" },
        message_id: 106172611603,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prev_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_next_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611603,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611603`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_pre_state/state_post_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611604,
        chat: { id: 1234, type: "private" },
        message_id: 106172611604,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pre_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_post_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611604,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611604`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePreState/statePostState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116041,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116041,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePreState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        statePostState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116041,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116041`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePreStates/statePostStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116042,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116042,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePreStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        statePostStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116042,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116042`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_pre_states/state_post_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116043,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116043,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pre_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_post_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116043,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116043`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_older_state/state_newer_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611605,
        chat: { id: 1234, type: "private" },
        message_id: 106172611605,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_older_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newer_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611605,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611605`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_oldest_state/state_newest_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611606,
        chat: { id: 1234, type: "private" },
        message_id: 106172611606,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_oldest_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newest_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611606,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611606`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_oldest_states/state_newest_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116061,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116061,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_oldest_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newest_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116061,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116061`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_oldest_reaction/state_newest_reaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611607,
        chat: { id: 1234, type: "private" },
        message_id: 106172611607,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_oldest_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newest_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611607,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611607`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_oldest_reactions/state_newest_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116071,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116071,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_oldest_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newest_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116071,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116071`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_oldest_value/state_newest_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611608,
        chat: { id: 1234, type: "private" },
        message_id: 106172611608,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_oldest_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newest_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611608,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611608`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_old_values/state_new_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116081,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116081,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_old_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_new_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116081,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116081`,
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

  it("uses direct-envelope state_previous_values/state_current_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611612,
        chat: { id: 1234, type: "private" },
        message_id: 106172611612,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_previous_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_current_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611612,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611612`,
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

  it("uses direct-envelope statePreviousReaction/stateCurrentReaction raw update when parsed reaction omits arrays", async () => {
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
        statePreviousReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateCurrentReaction: [
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

  it("uses direct-envelope statePreviousValues/stateCurrentValues raw update when parsed reaction omits arrays", async () => {
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
        statePreviousValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateCurrentValues: [
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

  it("uses direct-envelope statePreviousValue/stateCurrentValue raw update when parsed reaction omits arrays", async () => {
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
        statePreviousValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateCurrentValue: [
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

  it("uses direct-envelope statePriorReaction/stateLatestReaction raw update when parsed reaction omits arrays", async () => {
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
        statePriorReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestReaction: [
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

  it("uses direct-envelope statePriorReactions/stateLatestReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611645,
        chat: { id: 1234, type: "private" },
        message_id: 106172611645,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePriorReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611645,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611645`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earliest_reactions/state_latest_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611646,
        chat: { id: 1234, type: "private" },
        message_id: 106172611646,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earliest_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611646,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611646`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarliestReactions/stateLatestReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611647,
        chat: { id: 1234, type: "private" },
        message_id: 106172611647,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarliestReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611647,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611647`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earliest_reaction/state_latest_reaction raw update when parsed reaction omits arrays", async () => {
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
        state_earliest_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_reaction: [
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

  it("uses direct-envelope stateEarliestReaction/stateLatestReaction raw update when parsed reaction omits arrays", async () => {
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
        stateEarliestReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestReaction: [
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

  it("uses direct-envelope state_earliest_value/state_latest_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611625,
        chat: { id: 1234, type: "private" },
        message_id: 106172611625,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earliest_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611625,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611625`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_beginning_reaction/state_ending_reaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116255,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116255,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_beginning_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_ending_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116255,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116255`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_start_reaction/state_end_reaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116256,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116256,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_start_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_end_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116256,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116256`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateStartReaction/stateEndReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116260,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116260,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateStartReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116260,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116260`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeginningReaction/stateEndingReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116266,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeginningReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndingReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116266`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_beginning_state/state_ending_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116262,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_beginning_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_ending_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116262`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeginningState/stateEndingState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116263,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116263,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeginningState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndingState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116263,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116263`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_start_state/state_end_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116257,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116257,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_start_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_end_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116257,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116257`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateStartState/stateEndState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116261,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116261,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateStartState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116261,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116261`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateStartStates/stateEndStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116264,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateStartStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116264`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateStartReactions/stateEndReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116265,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateStartReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116265`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeginningReactions/stateEndingReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261162651,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162651,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeginningReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndingReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162651,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162651`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_start_value/state_end_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116258,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116258,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_start_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_end_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116258,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116258`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateStartValue/stateEndValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116259,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116259,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateStartValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116259,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116259`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeginningValue/stateEndingValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261162591,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162591,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeginningValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndingValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162591,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162591`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateStartValues/stateEndValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261162592,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162592,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateStartValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162592,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162592`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeginningValues/stateEndingValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261162593,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162593,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeginningValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndingValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162593,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162593`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeginningStates/stateEndingStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261162594,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162594,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeginningStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateEndingStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162594,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162594`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_beginning_states/state_ending_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261162595,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162595,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_beginning_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_ending_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162595,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162595`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_start_states/state_end_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261162596,
        chat: { id: 1234, type: "private" },
        message_id: 10617261162596,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_start_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_end_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261162596,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261162596`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_beginning_value/state_ending_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611626,
        chat: { id: 1234, type: "private" },
        message_id: 106172611626,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_beginning_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_ending_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611626,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611626`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_beginning_values/state_ending_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116261,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116261,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_beginning_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_ending_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116261,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116261`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_start_values/state_end_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116262,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_start_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_end_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116262`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_beginning_reactions/state_ending_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116299,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116299,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_beginning_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_ending_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116299,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116299`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_start_reactions/state_end_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116301,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116301,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_start_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_end_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116301,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116301`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_initial_reaction/state_final_reaction raw update when parsed reaction omits arrays", async () => {
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
        state_initial_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_final_reaction: [
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

  it("uses direct-envelope stateInitialReaction/stateFinalReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611601,
        chat: { id: 1234, type: "private" },
        message_id: 106172611601,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateInitialReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateFinalReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611601,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611601`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateInitialReactions/stateFinalReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611602,
        chat: { id: 1234, type: "private" },
        message_id: 106172611602,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateInitialReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateFinalReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611602,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611602`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_initial_reactions/state_final_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611605,
        chat: { id: 1234, type: "private" },
        message_id: 106172611605,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_initial_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_final_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611605,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611605`,
      expect.any(Object),
    );
  });
  it("uses direct-envelope state_first_reaction/state_last_reaction raw update when parsed reaction omits arrays", async () => {
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
        state_first_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_last_reaction: [
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

  it("uses direct-envelope state_first_reactions/state_last_reactions raw update when parsed reaction omits arrays", async () => {
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
        state_first_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_last_reactions: [
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

  it("uses direct-envelope state_former_reaction/state_latter_reaction raw update when parsed reaction omits arrays", async () => {
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
        state_former_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latter_reaction: [
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

  it("uses direct-envelope stateFormerReaction/stateLatterReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611621,
        chat: { id: 1234, type: "private" },
        message_id: 106172611621,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFormerReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatterReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611621,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611621`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFormerReactions/stateLatterReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611622,
        chat: { id: 1234, type: "private" },
        message_id: 106172611622,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFormerReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatterReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611622,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611622`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_former_reactions/state_latter_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611623,
        chat: { id: 1234, type: "private" },
        message_id: 106172611623,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_former_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latter_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611623,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611623`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_former_value/state_latter_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261262,
        chat: { id: 1234, type: "private" },
        message_id: 10617261262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_former_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latter_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261262,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261262`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFormerValue/stateLatterValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261662,
        chat: { id: 1234, type: "private" },
        message_id: 10617261662,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFormerValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatterValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261662,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261662`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFormerValues/stateLatterValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261664,
        chat: { id: 1234, type: "private" },
        message_id: 10617261664,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFormerValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatterValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261664,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261664`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_former_values/state_latter_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261665,
        chat: { id: 1234, type: "private" },
        message_id: 10617261665,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_former_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latter_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261665,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261665`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_initial_value/state_final_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261263,
        chat: { id: 1234, type: "private" },
        message_id: 10617261263,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_initial_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_final_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261263,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261263`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateInitialValue/stateFinalValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261663,
        chat: { id: 1234, type: "private" },
        message_id: 10617261663,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateInitialValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateFinalValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261663,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261663`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateInitialValues/stateFinalValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172616632,
        chat: { id: 1234, type: "private" },
        message_id: 106172616632,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateInitialValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateFinalValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172616632,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172616632`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_initial_values/state_final_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261363,
        chat: { id: 1234, type: "private" },
        message_id: 10617261363,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_initial_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_final_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261363,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261363`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_first_value/state_last_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261264,
        chat: { id: 1234, type: "private" },
        message_id: 10617261264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_first_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_last_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261264`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_first_values/state_last_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261364,
        chat: { id: 1234, type: "private" },
        message_id: 10617261364,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_first_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_last_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261364,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261364`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFirstValues/stateLastValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261464,
        chat: { id: 1234, type: "private" },
        message_id: 10617261464,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFirstValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLastValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261464,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261464`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFirstReaction/stateLastReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261465,
        chat: { id: 1234, type: "private" },
        message_id: 10617261465,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFirstReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLastReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261465,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261465`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFirstReactions/stateLastReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261564,
        chat: { id: 1234, type: "private" },
        message_id: 10617261564,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFirstReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLastReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261564,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261564`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFirstStates/stateLastStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261565,
        chat: { id: 1234, type: "private" },
        message_id: 10617261565,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFirstStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLastStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261565,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261565`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFormerStates/stateLatterStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261566,
        chat: { id: 1234, type: "private" },
        message_id: 10617261566,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFormerStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatterStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261566,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261566`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_former_states/state_latter_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261567,
        chat: { id: 1234, type: "private" },
        message_id: 10617261567,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_former_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latter_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261567,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261567`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earlier_value/state_later_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261265,
        chat: { id: 1234, type: "private" },
        message_id: 10617261265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earlier_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_later_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261265`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarlierValue/stateLaterValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261365,
        chat: { id: 1234, type: "private" },
        message_id: 10617261365,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarlierValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLaterValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261365,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261365`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarlierValues/stateLaterValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261366,
        chat: { id: 1234, type: "private" },
        message_id: 10617261366,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarlierValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLaterValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261366,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261366`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earlier_values/state_later_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261367,
        chat: { id: 1234, type: "private" },
        message_id: 10617261367,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earlier_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_later_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261367,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261367`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earlier_reaction/state_later_reaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261266,
        chat: { id: 1234, type: "private" },
        message_id: 10617261266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earlier_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_later_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261266`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_earlier_reactions/state_later_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261267,
        chat: { id: 1234, type: "private" },
        message_id: 10617261267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earlier_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_later_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261267`,
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

  it("uses direct-envelope statePrevReaction/stateNextReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261267,
        chat: { id: 1234, type: "private" },
        message_id: 10617261267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrevReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNextReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261267`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePrevReactions/stateNextReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261271,
        chat: { id: 1234, type: "private" },
        message_id: 10617261271,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrevReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNextReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261271,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261271`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePrevValue/stateNextValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261268,
        chat: { id: 1234, type: "private" },
        message_id: 10617261268,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrevValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNextValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261268,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261268`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePrevValues/stateNextValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261270,
        chat: { id: 1234, type: "private" },
        message_id: 10617261270,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrevValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNextValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261270,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261270`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePrev/stateNext raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261269,
        chat: { id: 1234, type: "private" },
        message_id: 10617261269,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrev: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNext: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261269,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261269`,
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

  it("uses direct-envelope state_prev_values/state_next_values raw update when parsed reaction omits arrays", async () => {
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
        state_prev_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_next_values: [
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

  it("uses direct-envelope state_prev_states/state_next_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261264,
        chat: { id: 1234, type: "private" },
        message_id: 10617261264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prev_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_next_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261264`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prev_reactions/state_next_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261265,
        chat: { id: 1234, type: "private" },
        message_id: 10617261265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prev_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_next_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261265`,
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

  it("uses direct-envelope statePriorValue/stateLatestValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261172,
        chat: { id: 1234, type: "private" },
        message_id: 10617261172,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePriorValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261172,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261172`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarliestValue/stateLatestValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261174,
        chat: { id: 1234, type: "private" },
        message_id: 10617261174,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarliestValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261174,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261174`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePriorValues/stateLatestValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261173,
        chat: { id: 1234, type: "private" },
        message_id: 10617261173,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePriorValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261173,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261173`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prior_values/state_latest_values raw update when parsed reaction omits arrays", async () => {
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
        state_prior_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_values: [
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

  it("uses direct-envelope state_earliest_values/state_latest_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261176,
        chat: { id: 1234, type: "private" },
        message_id: 10617261176,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_earliest_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261176,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261176`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateEarliestValues/stateLatestValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261177,
        chat: { id: 1234, type: "private" },
        message_id: 10617261177,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateEarliestValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatestValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261177,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261177`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_prior_reactions/state_latest_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261171,
        chat: { id: 1234, type: "private" },
        message_id: 10617261171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_prior_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_latest_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261171`,
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

  it("uses direct-envelope state_pres/state_posts raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261232,
        chat: { id: 1234, type: "private" },
        message_id: 10617261232,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pres: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_posts: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261232,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261232`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePres/statePosts raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261250,
        chat: { id: 1234, type: "private" },
        message_id: 10617261250,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePres: [{ type: "emoji", emoji: FIRE_EMOJI }],
        statePosts: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261250,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261250`,
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

  it("uses direct-envelope statePreValue/statePostValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261171,
        chat: { id: 1234, type: "private" },
        message_id: 10617261171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePreValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        statePostValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261171`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePreValues/statePostValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261172,
        chat: { id: 1234, type: "private" },
        message_id: 10617261172,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePreValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        statePostValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261172,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261172`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_pre_values/state_post_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261173,
        chat: { id: 1234, type: "private" },
        message_id: 10617261173,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pre_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_post_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261173,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261173`,
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

  it("uses direct-envelope statePrior/stateLatest raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261174,
        chat: { id: 1234, type: "private" },
        message_id: 10617261174,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrior: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatest: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261174,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261174`,
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

  it("uses direct-envelope statePriors/stateLatests raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261171,
        chat: { id: 1234, type: "private" },
        message_id: 10617261171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePriors: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateLatests: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261171,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261171`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_previouss/state_currents raw update when parsed reaction omits arrays", async () => {
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
        state_previouss: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_currents: [
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

  it("uses direct-envelope statePreviouss/stateCurrents raw update when parsed reaction omits arrays", async () => {
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
        statePreviouss: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateCurrents: [
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

  it("uses direct-envelope stateOld/stateNew raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611656,
        chat: { id: 1234, type: "private" },
        message_id: 106172611656,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOld: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNew: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611656,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611656`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_old_state/state_new_state raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116541,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116541,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_old_state: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_new_state: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116541,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116541`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldState/stateNewState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116544,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116544,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116544,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116544`,
      expect.any(Object),
    );
  });
  it("uses direct-envelope state_old_states/state_new_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116542,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116542,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_old_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_new_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116542,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116542`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldStates/stateNewStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116543,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116543,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116543,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116543`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_old_value/state_new_value raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611654,
        chat: { id: 1234, type: "private" },
        message_id: 106172611654,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_old_value: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_new_value: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611654,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611654`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldValue/stateNewValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116544,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116544,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116544,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116544`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldValues/stateNewValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116545,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116545,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116545,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116545`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_old_reaction/state_new_reaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611655,
        chat: { id: 1234, type: "private" },
        message_id: 106172611655,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_old_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_new_reaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611655,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611655`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_old_reactions/state_new_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116551,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116551,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_old_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_new_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116551,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116551`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldReaction/stateNewReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116554,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116554,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116554,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116554`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldReactions/stateNewReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116556,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116556,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116556,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116556`,
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

  it("uses direct-envelope stateOlds/stateNews raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116744,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116744,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOlds: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNews: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116744,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116744`,
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

  it("uses direct-envelope state_older_states/state_newer_states raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116643,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116643,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_older_states: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newer_states: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116643,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116643`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOlder/stateNewer raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116644,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116644,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOlder: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewer: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116644,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116644`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOlderState/stateNewerState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116645,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116645,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOlderState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewerState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116645,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116645`,
      expect.any(Object),
    );
  });
  it("uses direct-envelope stateOlderStates/stateNewerStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116646,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116646,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOlderStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewerStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116646,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116646`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldestState/stateNewestState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116647,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116647,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldestState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewestState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116647,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116647`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldestStates/stateNewestStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116648,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116648,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldestStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewestStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116648,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116648`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldestReaction/stateNewestReaction raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116649,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116649,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldestReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewestReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116649,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116649`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldestValue/stateNewestValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261166491,
        chat: { id: 1234, type: "private" },
        message_id: 10617261166491,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldestValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewestValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261166491,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261166491`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldestValues/stateNewestValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261166492,
        chat: { id: 1234, type: "private" },
        message_id: 10617261166492,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldestValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewestValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261166492,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261166492`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_oldest_values/state_newest_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717261166493,
        chat: { id: 1234, type: "private" },
        message_id: 10617261166493,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_oldest_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_newest_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617261166493,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617261166493`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateOldestReactions/stateNewestReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 50371726116650,
        chat: { id: 1234, type: "private" },
        message_id: 1061726116650,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateOldestReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNewestReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 1061726116650,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 1061726116650`,
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

  it("uses direct-envelope state_from_reactions/state_to_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611616,
        chat: { id: 1234, type: "private" },
        message_id: 106172611616,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_from_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_to_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611616,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611616`,
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

  it("uses direct-envelope state_from_values/state_to_values raw update when parsed reaction omits arrays", async () => {
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
        state_from_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_to_values: [
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

  it("uses direct-envelope stateFromValues/stateToValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611631,
        chat: { id: 1234, type: "private" },
        message_id: 106172611631,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFromValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateToValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611631,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611631`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFromValue/stateToValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611633,
        chat: { id: 1234, type: "private" },
        message_id: 106172611633,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFromValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateToValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611633,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611633`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFromReactions/stateToReactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611632,
        chat: { id: 1234, type: "private" },
        message_id: 106172611632,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFromReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateToReactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611632,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611632`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateFroms/stateTos raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611634,
        chat: { id: 1234, type: "private" },
        message_id: 106172611634,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateFroms: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateTos: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611634,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611634`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_froms/state_tos raw update when parsed reaction omits arrays", async () => {
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
        update_id: 5037172611635,
        chat: { id: 1234, type: "private" },
        message_id: 106172611635,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_froms: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_tos: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 106172611635,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 106172611635`,
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

  it("uses direct-envelope state_before_values/state_after_values raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717264,
        chat: { id: 1234, type: "private" },
        message_id: 10617264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_before_values: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_after_values: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617264,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617264`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeforeValues/stateAfterValues raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717265,
        chat: { id: 1234, type: "private" },
        message_id: 10617265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeforeValues: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfterValues: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617265,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617265`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope stateBeforeValue/stateAfterValue raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717266,
        chat: { id: 1234, type: "private" },
        message_id: 10617266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        stateBeforeValue: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateAfterValue: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617266,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617266`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope state_pre_reactions/state_post_reactions raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717267,
        chat: { id: 1234, type: "private" },
        message_id: 10617267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        state_pre_reactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        state_post_reactions: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617267,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617267`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePreReactions/statePostReactions raw update when parsed reaction omits arrays", async () => {
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
        statePreReactions: [{ type: "emoji", emoji: FIRE_EMOJI }],
        statePostReactions: [
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

  it("uses direct-envelope statePreReaction/statePostReaction raw update when parsed reaction omits arrays", async () => {
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
        statePreReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        statePostReaction: [
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

  it("uses direct-envelope statePrevState/stateNextState raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717270,
        chat: { id: 1234, type: "private" },
        message_id: 10617270,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrevState: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNextState: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617270,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617270`,
      expect.any(Object),
    );
  });

  it("uses direct-envelope statePrevStates/stateNextStates raw update when parsed reaction omits arrays", async () => {
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
        update_id: 503717271,
        chat: { id: 1234, type: "private" },
        message_id: 10617271,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        statePrevStates: [{ type: "emoji", emoji: FIRE_EMOJI }],
        stateNextStates: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 10617271,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 10617271`,
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
