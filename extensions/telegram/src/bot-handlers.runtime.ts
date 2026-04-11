import type { Message } from "@grammyjs/types";
import { requestHeartbeatNow } from "openclaw/plugin-sdk/channel-runtime";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-helpers";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  buildCommandsMessagePaginated,
  resolveStoredModelOverride,
} from "openclaw/plugin-sdk/command-auth";
import { writeConfigFile } from "openclaw/plugin-sdk/config-runtime";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  updateSessionStore,
} from "openclaw/plugin-sdk/config-runtime";
import type { DmPolicy } from "openclaw/plugin-sdk/config-runtime";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/config-runtime";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/infra-runtime";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  isSenderAllowed,
  normalizeDmAllowFromWithStore,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveDefaultModelForAgent,
} from "./bot-handlers.agent.runtime.js";
import { buildTelegramInboundDebounceKey } from "./bot-handlers.debounce-key.js";
import {
  hasInboundMedia,
  hasReplyTargetMedia,
  isMediaSizeLimitError,
  isRecoverableMediaGroupError,
  resolveInboundMediaFileId,
} from "./bot-handlers.media.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import {
  parseTelegramNativeCommandCallbackData,
  RegisterTelegramHandlerParams,
} from "./bot-native-commands.js";
import {
  MEDIA_GROUP_TIMEOUT_MS,
  type MediaGroupEntry,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.js";
import {
  getTelegramTextParts,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramForumFlag,
  resolveTelegramForumThreadId,
  resolveTelegramGroupAllowFromContext,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import { buildCommandsPaginationKeyboard } from "./command-ui.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { enforceTelegramDmAccess } from "./dm-access.js";
import { resolveTelegramExecApproval } from "./exec-approval-resolver.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  shouldEnableTelegramExecApprovalButtons,
} from "./exec-approvals.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { dispatchTelegramPluginInteractiveHandler } from "./interactive-dispatch.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";
import { buildInlineKeyboard } from "./send.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  telegramTransport,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
  telegramDeps = defaultTelegramBotDeps,
}: RegisterTelegramHandlerParams) => {
  const mediaRuntimeOptions = resolveTelegramMediaRuntimeOptions({
    cfg,
    accountId,
    token: opts.token,
    transport: telegramTransport,
  });
  const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;
  const mediaGroupTimeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;
  type TelegramDebounceLane = "default" | "forward";
  type TelegramDebounceEntry = {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    storeAllowFrom: string[];
    receivedAtMs: number;
    debounceKey: string | null;
    debounceLane: TelegramDebounceLane;
    botUsername?: string;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    const forwardMeta = msg as {
      forward_origin?: unknown;
      forward_from?: unknown;
      forward_from_chat?: unknown;
      forward_sender_name?: unknown;
      forward_date?: unknown;
    };
    return (forwardMeta.forward_origin ??
      forwardMeta.forward_from ??
      forwardMeta.forward_from_chat ??
      forwardMeta.forward_sender_name ??
      forwardMeta.forward_date)
      ? "forward"
      : "default";
  };
  const buildSyntheticTextMessage = (params: {
    base: Message;
    text: string;
    date?: number;
    from?: Message["from"];
  }): Message => ({
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: undefined,
    ...(params.date != null ? { date: params.date } : {}),
  });
  const buildSyntheticContext = (
    ctx: Pick<TelegramContext, "me"> & { getFile?: unknown },
    message: Message,
  ): TelegramContext => {
    const getFile =
      typeof ctx.getFile === "function"
        ? (ctx.getFile as TelegramContext["getFile"]).bind(ctx as object)
        : async () => ({});
    return { message, me: ctx.me, getFile };
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    resolveDebounceMs: (entry) =>
      entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      const hasDebounceableText = shouldDebounceTextInbound({
        text,
        cfg,
        commandOptions: { botUsername: entry.botUsername },
      });
      if (entry.debounceLane === "forward") {
        // Forwarded bursts often split text + media into adjacent updates.
        // Debounce media-only forward entries too so they can coalesce.
        return hasDebounceableText || entry.allMedia.length > 0;
      }
      if (!hasDebounceableText) {
        return false;
      }
      return entry.allMedia.length === 0;
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        const replyMedia = await resolveReplyMediaForMessage(last.ctx, last.msg);
        await processMessage(
          last.ctx,
          last.allMedia,
          last.storeAllowFrom,
          {
            receivedAtMs: last.receivedAtMs,
            ingressBuffer: "inbound-debounce",
          },
          replyMedia,
        );
        return;
      }
      const combinedText = entries
        .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
        .filter(Boolean)
        .join("\n");
      const combinedMedia = entries.flatMap((entry) => entry.allMedia);
      if (!combinedText.trim() && combinedMedia.length === 0) {
        return;
      }
      const first = entries[0];
      const baseCtx = first.ctx;
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
      const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
      const replyMedia = await resolveReplyMediaForMessage(baseCtx, syntheticMessage);
      await processMessage(
        syntheticCtx,
        combinedMedia,
        first.storeAllowFrom,
        {
          ...(messageIdOverride ? { messageIdOverride } : {}),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "inbound-debounce",
        },
        replyMedia,
      );
    },
    onError: (err, items) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadId = items[0]?.msg.message_thread_id;
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadId != null ? { message_thread_id: threadId } : undefined,
          )
          .catch((sendErr) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
          });
      }
    },
  });

  const resolveTelegramSessionState = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
    senderId?: string | number;
  }): {
    agentId: string;
    sessionEntry: ReturnType<typeof loadSessionStore>[string] | undefined;
    sessionKey: string;
    model?: string;
  } => {
    const runtimeCfg = telegramDeps.loadConfig();
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const topicThreadId = resolvedThreadId ?? dmThreadId;
    const { topicConfig } = resolveTelegramGroupConfig(params.chatId, topicThreadId);
    const { route } = resolveTelegramConversationRoute({
      cfg: runtimeCfg,
      accountId,
      chatId: params.chatId,
      isGroup: params.isGroup,
      resolvedThreadId,
      replyThreadId: topicThreadId,
      senderId: params.senderId,
      topicAgentId: topicConfig?.agentId,
    });
    const baseSessionKey = resolveTelegramConversationBaseSessionKey({
      cfg: runtimeCfg,
      route,
      chatId: params.chatId,
      isGroup: params.isGroup,
      senderId: params.senderId,
    });
    const threadKeys =
      dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${params.chatId}:${dmThreadId}` })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, {
      agentId: route.agentId,
    });
    const store = loadSessionStore(storePath);
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
      defaultProvider: resolveDefaultModelForAgent({
        cfg: runtimeCfg,
        agentId: route.agentId,
      }).provider,
    });
    if (storedOverride) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        model: storedOverride.provider
          ? `${storedOverride.provider}/${storedOverride.model}`
          : storedOverride.model,
      };
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        model: `${provider}/${model}`,
      };
    }
    const modelCfg = runtimeCfg.agents?.defaults?.model;
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary,
    };
  };

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: TelegramMediaRef[] = [];
      for (const { ctx } of entry.messages) {
        let media;
        try {
          media = await resolveMedia({
            ctx,
            maxBytes: mediaMaxBytes,
            ...mediaRuntimeOptions,
          });
        } catch (mediaErr) {
          if (!isRecoverableMediaGroupError(mediaErr)) {
            throw mediaErr;
          }
          runtime.log?.(
            warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`),
          );
          continue;
        }
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await loadStoreAllowFrom();
      const replyMedia = await resolveReplyMediaForMessage(primaryEntry.ctx, primaryEntry.msg);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom, undefined, replyMedia);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        return;
      }

      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });

      const storeAllowFrom = await loadStoreAllowFrom();
      const baseCtx = first.ctx;

      await processMessage(buildSyntheticContext(baseCtx, syntheticMessage), [], storeAllowFrom, {
        messageIdOverride: String(last.msg.message_id),
        receivedAtMs: first.receivedAtMs,
        ingressBuffer: "text-fragment",
      });
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const queueTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentProcessing = textFragmentProcessing
      .then(async () => {
        await flushTextFragments(entry);
      })
      .catch(() => undefined);
    await textFragmentProcessing;
  };

  const runTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  const loadStoreAllowFrom = async () =>
    telegramDeps.readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);

  const resolveReplyMediaForMessage = async (
    ctx: TelegramContext,
    msg: Message,
  ): Promise<TelegramMediaRef[]> => {
    const replyMessage = msg.reply_to_message;
    if (!replyMessage || !hasInboundMedia(replyMessage)) {
      return [];
    }
    const replyFileId = resolveInboundMediaFileId(replyMessage);
    if (!replyFileId) {
      return [];
    }
    try {
      const media = await resolveMedia({
        ctx: {
          message: replyMessage,
          me: ctx.me,
          getFile: async () => await bot.api.getFile(replyFileId),
        },
        maxBytes: mediaMaxBytes,
        ...mediaRuntimeOptions,
      });
      if (!media) {
        return [];
      }
      return [
        {
          path: media.path,
          contentType: media.contentType,
          stickerMetadata: media.stickerMetadata,
        },
      ];
    } catch (err) {
      logger.warn({ chatId: msg.chat.id, error: String(err) }, "reply media fetch failed");
      return [];
    }
  };

  const isAllowlistAuthorized = (
    allow: NormalizedAllowFrom,
    senderId: string,
    senderUsername: string,
  ) =>
    allow.hasWildcard ||
    (allow.hasEntries &&
      isSenderAllowed({
        allow,
        senderId,
        senderUsername,
      }));

  const shouldSkipGroupMessage = (params: {
    isGroup: boolean;
    chatId: string | number;
    chatTitle?: string;
    resolvedThreadId?: number;
    senderId: string;
    senderUsername: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    hasGroupAllowOverride: boolean;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
  }) => {
    const {
      isGroup,
      chatId,
      chatTitle,
      resolvedThreadId,
      senderId,
      senderUsername,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      groupConfig,
      topicConfig,
    } = params;
    const baseAccess = evaluateTelegramGroupBaseAccess({
      isGroup,
      groupConfig,
      topicConfig,
      hasGroupAllowOverride,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });
    if (!baseAccess.allowed) {
      if (baseAccess.reason === "group-disabled") {
        logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
        return true;
      }
      if (baseAccess.reason === "topic-disabled") {
        logVerbose(
          `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
        );
        return true;
      }
      logVerbose(
        `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
      );
      return true;
    }
    if (!isGroup) {
      return false;
    }
    const policyAccess = evaluateTelegramGroupPolicyAccess({
      isGroup,
      chatId,
      cfg,
      telegramCfg,
      topicConfig,
      groupConfig,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      resolveGroupPolicy,
      enforcePolicy: true,
      useTopicAndGroupOverrides: true,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });
    if (!policyAccess.allowed) {
      if (policyAccess.reason === "group-policy-disabled") {
        logVerbose("Blocked telegram group message (groupPolicy: disabled)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-no-sender") {
        logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-empty") {
        logVerbose(
          "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
        );
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
        logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
        return true;
      }
      logger.info({ chatId, title: chatTitle, reason: "not-allowed" }, "skipping group message");
      return true;
    }
    return false;
  };

  type TelegramGroupAllowContext = Awaited<ReturnType<typeof resolveTelegramGroupAllowFromContext>>;
  type TelegramEventAuthorizationMode = "reaction" | "callback-scope" | "callback-allowlist";
  type TelegramEventAuthorizationResult = { allowed: true } | { allowed: false; reason: string };
  type TelegramEventAuthorizationContext = TelegramGroupAllowContext & { dmPolicy: DmPolicy };
  const getChat =
    typeof (bot.api as { getChat?: unknown }).getChat === "function"
      ? ((bot.api as { getChat: TelegramGetChat }).getChat.bind(bot.api) as TelegramGetChat)
      : undefined;

  const TELEGRAM_EVENT_AUTH_RULES: Record<
    TelegramEventAuthorizationMode,
    {
      enforceDirectAuthorization: boolean;
      enforceGroupAllowlistAuthorization: boolean;
      deniedDmReason: string;
      deniedGroupReason: string;
    }
  > = {
    reaction: {
      enforceDirectAuthorization: true,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "reaction unauthorized by dm policy/allowlist",
      deniedGroupReason: "reaction unauthorized by group allowlist",
    },
    "callback-scope": {
      enforceDirectAuthorization: false,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope",
    },
    "callback-allowlist": {
      enforceDirectAuthorization: true,
      // Group auth is already enforced by shouldSkipGroupMessage (group policy + allowlist).
      // An extra allowlist gate here would block users whose original command was authorized.
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist",
    },
  };

  const resolveTelegramEventAuthorizationContext = async (params: {
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    groupAllowContext?: TelegramGroupAllowContext;
  }): Promise<TelegramEventAuthorizationContext> => {
    const groupAllowContext =
      params.groupAllowContext ??
      (await resolveTelegramGroupAllowFromContext({
        chatId: params.chatId,
        accountId,
        isGroup: params.isGroup,
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
        groupAllowFrom,
        readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
        resolveTelegramGroupConfig,
      }));
    // Use direct config dmPolicy override if available for DMs
    const effectiveDmPolicy =
      !params.isGroup &&
      groupAllowContext.groupConfig &&
      "dmPolicy" in groupAllowContext.groupConfig
        ? (groupAllowContext.groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing")
        : (telegramCfg.dmPolicy ?? "pairing");
    return { dmPolicy: effectiveDmPolicy, ...groupAllowContext };
  };

  const authorizeTelegramEventSender = (params: {
    chatId: number;
    chatTitle?: string;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    mode: TelegramEventAuthorizationMode;
    context: TelegramEventAuthorizationContext;
  }): TelegramEventAuthorizationResult => {
    const { chatId, chatTitle, isGroup, senderId, senderUsername, mode, context } = params;
    const {
      dmPolicy,
      resolvedThreadId,
      storeAllowFrom,
      groupConfig,
      topicConfig,
      groupAllowOverride,
      effectiveGroupAllow,
      hasGroupAllowOverride,
    } = context;
    const authRules = TELEGRAM_EVENT_AUTH_RULES[mode];
    const {
      enforceDirectAuthorization,
      enforceGroupAllowlistAuthorization,
      deniedDmReason,
      deniedGroupReason,
    } = authRules;
    if (
      shouldSkipGroupMessage({
        isGroup,
        chatId,
        chatTitle,
        resolvedThreadId,
        senderId,
        senderUsername,
        effectiveGroupAllow,
        hasGroupAllowOverride,
        groupConfig,
        topicConfig,
      })
    ) {
      return { allowed: false, reason: "group-policy" };
    }

    if (!isGroup && enforceDirectAuthorization) {
      if (dmPolicy === "disabled") {
        logVerbose(
          `Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`,
        );
        return { allowed: false, reason: "direct-disabled" };
      }
      if (dmPolicy !== "open") {
        // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
        const dmAllowFrom = groupAllowOverride ?? allowFrom;
        const effectiveDmAllow = normalizeDmAllowFromWithStore({
          allowFrom: dmAllowFrom,
          storeAllowFrom,
          dmPolicy,
        });
        if (!isAllowlistAuthorized(effectiveDmAllow, senderId, senderUsername)) {
          logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
          return { allowed: false, reason: "direct-unauthorized" };
        }
      }
    }
    if (isGroup && enforceGroupAllowlistAuthorization) {
      if (!isAllowlistAuthorized(effectiveGroupAllow, senderId, senderUsername)) {
        logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
        return { allowed: false, reason: "group-unauthorized" };
      }
    }
    return { allowed: true };
  };

  // Raw ingress diagnostics for Telegram reaction updates.
  // This confirms whether message_reaction/message_reaction_count updates
  // are observed in-process before specialized handlers run.
  // Keep disabled by default; enable with explicit env flags when debugging.
  const reactionDiagEnabled =
    process.env.OPENCLAW_TELEGRAM_REACTION_DIAG_HANDLER === "1" ||
    process.env.OPENCLAW_TELEGRAM_REACTION_DIAG_POLL === "1";
  const reactionPipelineDiag = reactionDiagEnabled ? (runtime.error ?? runtime.info) : undefined;
  bot.use(async (ctx, next) => {
    const middlewareDiagAll = process.env.OPENCLAW_TELEGRAM_REACTION_DIAG_POLL === "1";
    const rawReaction =
      ctx.update?.message_reaction ??
      ((ctx.update as { messageReaction?: unknown } | undefined)?.messageReaction as
        | Record<string, unknown>
        | undefined);
    const rawReactionCount =
      ctx.update?.message_reaction_count ??
      ((ctx.update as { messageReactionCount?: unknown } | undefined)?.messageReactionCount as
        | Record<string, unknown>
        | undefined);
    const parsedReaction = ctx.messageReaction;
    const parsedReactionCount = ctx.messageReactionCount;
    const shouldEmitMiddlewareDiag =
      Boolean(reactionPipelineDiag) &&
      (middlewareDiagAll || rawReaction || rawReactionCount || parsedReaction || parsedReactionCount);

    let updateId = "n/a";
    let updateTypes = "none";
    if (shouldEmitMiddlewareDiag) {
      const typedUpdate = (ctx.update ?? {}) as Record<string, unknown>;
      updateId = typeof typedUpdate.update_id === "number" ? String(typedUpdate.update_id) : "n/a";
      updateTypes =
        Object.entries(typedUpdate)
          .filter(([key, value]) => key !== "update_id" && value !== undefined)
          .map(([key]) => key)
          .sort((a, b) => a.localeCompare(b))
          .join(",") || "none";
    }

    if (shouldEmitMiddlewareDiag) {
      reactionPipelineDiag?.(
        `[telegram-handler-middleware] account=${accountId} update_id=${updateId} update_types=${updateTypes} rawReaction=${Boolean(rawReaction)} rawReactionCount=${Boolean(rawReactionCount)} parsedReaction=${Boolean(parsedReaction)} parsedReactionCount=${Boolean(parsedReactionCount)}`,
      );
    }

    if (rawReaction || rawReactionCount) {
      const chatId = rawReaction?.chat?.id ?? rawReactionCount?.chat?.id ?? "unknown";
      const messageId = rawReaction?.message_id ?? rawReactionCount?.message_id ?? "unknown";
      const userId = rawReaction?.user?.id;
      const addedCount = rawReaction?.new_reaction?.length ?? 0;
      const countKinds = Array.isArray(rawReactionCount?.reactions)
        ? rawReactionCount.reactions.length
        : 0;
      reactionPipelineDiag?.(
        `[telegram-reaction-ingress] account=${accountId} chat=${chatId} msg=${messageId} hasReaction=${Boolean(rawReaction)} hasReactionCount=${Boolean(rawReactionCount)} user=${userId ?? "anon"} addedCount=${addedCount} countKinds=${countKinds}`,
      );
    }
    await next();
  });

  // Handle emoji reactions to messages.
  bot.on("message_reaction", async (ctx) => {
    try {
      const parsedReaction = ctx.messageReaction;
      const rawReaction =
        ctx.update?.message_reaction ??
        ((ctx.update as { messageReaction?: unknown } | undefined)?.messageReaction as
          | Record<string, unknown>
          | undefined);
      const reaction = parsedReaction ?? rawReaction;
      if (!reaction) {
        return;
      }

      const reactionEnvelope = reaction as {
        chat?: { id?: number; type?: string; is_forum?: boolean; title?: string };
        chat_id?: number | string;
        chatId?: number | string;
        chat_type?: string;
        chatType?: string;
        is_forum?: boolean;
        isForum?: boolean;
        chat_title?: string;
        chatTitle?: string;
        message_id?: number;
        messageId?: number;
        user_id?: number | string;
        userId?: number | string;
        from_user_id?: number | string;
        fromUserId?: number | string;
        author_user_id?: number | string;
        authorUserId?: number | string;
        sender_user_id?: number | string;
        senderUserId?: number | string;
        from_id?: number | string;
        fromId?: number | string;
        author_id?: number | string;
        authorId?: number | string;
        sender_id?: number | string;
        senderId?: number | string;
        actor_id?: number | string;
        actorId?: number | string;
        sender_chat_id?: number | string;
        senderChatId?: number | string;
        actor_chat_id?: number | string;
        actorChatId?: number | string;
        username?: string;
        from_user_username?: string;
        fromUserUsername?: string;
        author_user_username?: string;
        authorUserUsername?: string;
        sender_user_username?: string;
        senderUserUsername?: string;
        from_username?: string;
        fromUsername?: string;
        author_username?: string;
        authorUsername?: string;
        sender_username?: string;
        senderUsername?: string;
        actor_username?: string;
        actorUsername?: string;
        sender_chat_username?: string;
        senderChatUsername?: string;
        actor_chat_username?: string;
        actorChatUsername?: string;
        title?: string;
        sender_chat_title?: string;
        senderChatTitle?: string;
        actor_chat_title?: string;
        actorChatTitle?: string;
        first_name?: string;
        firstName?: string;
        last_name?: string;
        lastName?: string;
        is_bot?: boolean;
        isBot?: boolean;
        user?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        from?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        from_user?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        fromUser?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        author?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        author_user?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        authorUser?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        actor?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        sender?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        sender_user?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        senderUser?: {
          id?: number;
          username?: string;
          is_bot?: boolean;
          first_name?: string;
          last_name?: string;
        };
        actor_chat?: {
          id?: number;
          username?: string;
          title?: string;
        };
        actorChat?: {
          id?: number;
          username?: string;
          title?: string;
        };
        sender_chat?: {
          id?: number;
          username?: string;
          title?: string;
        };
        senderChat?: {
          id?: number;
          username?: string;
          title?: string;
        };
      };
      const rawReactionEnvelope = rawReaction as
        | {
            chat?: { id?: number; type?: string; is_forum?: boolean; title?: string };
            chat_id?: number | string;
            chatId?: number | string;
            chat_type?: string;
            chatType?: string;
            is_forum?: boolean;
            isForum?: boolean;
            chat_title?: string;
            chatTitle?: string;
            message_id?: number;
            messageId?: number;
            user_id?: number | string;
            userId?: number | string;
            from_user_id?: number | string;
            fromUserId?: number | string;
            author_user_id?: number | string;
            authorUserId?: number | string;
            sender_user_id?: number | string;
            senderUserId?: number | string;
            from_id?: number | string;
            fromId?: number | string;
            author_id?: number | string;
            authorId?: number | string;
            sender_id?: number | string;
            senderId?: number | string;
            actor_id?: number | string;
            actorId?: number | string;
            sender_chat_id?: number | string;
            senderChatId?: number | string;
            actor_chat_id?: number | string;
            actorChatId?: number | string;
            username?: string;
            from_user_username?: string;
            fromUserUsername?: string;
            author_user_username?: string;
            authorUserUsername?: string;
            sender_user_username?: string;
            senderUserUsername?: string;
            from_username?: string;
            fromUsername?: string;
            author_username?: string;
            authorUsername?: string;
            sender_username?: string;
            senderUsername?: string;
            actor_username?: string;
            actorUsername?: string;
            sender_chat_username?: string;
            senderChatUsername?: string;
            actor_chat_username?: string;
            actorChatUsername?: string;
            title?: string;
            sender_chat_title?: string;
            senderChatTitle?: string;
            actor_chat_title?: string;
            actorChatTitle?: string;
            first_name?: string;
            firstName?: string;
            last_name?: string;
            lastName?: string;
            is_bot?: boolean;
            isBot?: boolean;
            user?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            from?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            from_user?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            fromUser?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            author?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            author_user?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            authorUser?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            actor?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            sender?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            sender_user?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            senderUser?: {
              id?: number;
              username?: string;
              is_bot?: boolean;
              first_name?: string;
              last_name?: string;
            };
            actor_chat?: {
              id?: number;
              username?: string;
              title?: string;
            };
            actorChat?: {
              id?: number;
              username?: string;
              title?: string;
            };
            sender_chat?: {
              id?: number;
              username?: string;
              title?: string;
            };
            senderChat?: {
              id?: number;
              username?: string;
              title?: string;
            };
          }
        | undefined;
      const parseNumericId = (value: unknown): number | undefined => {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === "bigint") {
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) ? parsed : undefined;
        }
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
      };
      const reactionChat =
        reactionEnvelope.chat ??
        rawReactionEnvelope?.chat ??
        (() => {
          const flattenedChatId =
            parseNumericId(reactionEnvelope.chat_id ?? reactionEnvelope.chatId) ??
            parseNumericId(rawReactionEnvelope?.chat_id ?? rawReactionEnvelope?.chatId);
          if (flattenedChatId == null) {
            return undefined;
          }
          return {
            id: flattenedChatId,
            type:
              reactionEnvelope.chat_type ??
              reactionEnvelope.chatType ??
              rawReactionEnvelope?.chat_type ??
              rawReactionEnvelope?.chatType,
            is_forum:
              reactionEnvelope.is_forum ??
              reactionEnvelope.isForum ??
              rawReactionEnvelope?.is_forum ??
              rawReactionEnvelope?.isForum,
            title:
              reactionEnvelope.chat_title ??
              reactionEnvelope.chatTitle ??
              rawReactionEnvelope?.chat_title ??
              rawReactionEnvelope?.chatTitle,
          };
        })();
      const messageId =
        parseNumericId(reactionEnvelope.message_id ?? reactionEnvelope.messageId) ??
        parseNumericId(rawReactionEnvelope?.message_id ?? rawReactionEnvelope?.messageId);
      const user =
        reactionEnvelope.user ??
        reactionEnvelope.from ??
        reactionEnvelope.from_user ??
        reactionEnvelope.fromUser ??
        reactionEnvelope.author ??
        reactionEnvelope.author_user ??
        reactionEnvelope.authorUser ??
        reactionEnvelope.actor ??
        reactionEnvelope.sender ??
        reactionEnvelope.sender_user ??
        reactionEnvelope.senderUser ??
        (reactionEnvelope.actor_chat
          ? {
              id: reactionEnvelope.actor_chat.id,
              username: reactionEnvelope.actor_chat.username,
              first_name: reactionEnvelope.actor_chat.title,
            }
          : undefined) ??
        (reactionEnvelope.actorChat
          ? {
              id: reactionEnvelope.actorChat.id,
              username: reactionEnvelope.actorChat.username,
              first_name: reactionEnvelope.actorChat.title,
            }
          : undefined) ??
        (reactionEnvelope.sender_chat
          ? {
              id: reactionEnvelope.sender_chat.id,
              username: reactionEnvelope.sender_chat.username,
              first_name: reactionEnvelope.sender_chat.title,
            }
          : undefined) ??
        (reactionEnvelope.senderChat
          ? {
              id: reactionEnvelope.senderChat.id,
              username: reactionEnvelope.senderChat.username,
              first_name: reactionEnvelope.senderChat.title,
            }
          : undefined) ??
        rawReactionEnvelope?.user ??
        rawReactionEnvelope?.from ??
        rawReactionEnvelope?.from_user ??
        rawReactionEnvelope?.fromUser ??
        rawReactionEnvelope?.author ??
        rawReactionEnvelope?.author_user ??
        rawReactionEnvelope?.authorUser ??
        rawReactionEnvelope?.actor ??
        rawReactionEnvelope?.sender ??
        rawReactionEnvelope?.sender_user ??
        rawReactionEnvelope?.senderUser ??
        (rawReactionEnvelope?.actor_chat
          ? {
              id: rawReactionEnvelope.actor_chat.id,
              username: rawReactionEnvelope.actor_chat.username,
              first_name: rawReactionEnvelope.actor_chat.title,
            }
          : undefined) ??
        (rawReactionEnvelope?.actorChat
          ? {
              id: rawReactionEnvelope.actorChat.id,
              username: rawReactionEnvelope.actorChat.username,
              first_name: rawReactionEnvelope.actorChat.title,
            }
          : undefined) ??
        (rawReactionEnvelope?.sender_chat
          ? {
              id: rawReactionEnvelope.sender_chat.id,
              username: rawReactionEnvelope.sender_chat.username,
              first_name: rawReactionEnvelope.sender_chat.title,
            }
          : undefined) ??
        (rawReactionEnvelope?.senderChat
          ? {
              id: rawReactionEnvelope.senderChat.id,
              username: rawReactionEnvelope.senderChat.username,
              first_name: rawReactionEnvelope.senderChat.title,
            }
          : undefined) ??
        (() => {
          const flattenedUserId =
            parseNumericId(
              reactionEnvelope.user_id ??
                reactionEnvelope.userId ??
                reactionEnvelope.from_user_id ??
                reactionEnvelope.fromUserId ??
                reactionEnvelope.author_user_id ??
                reactionEnvelope.authorUserId ??
                reactionEnvelope.sender_user_id ??
                reactionEnvelope.senderUserId ??
                reactionEnvelope.from_id ??
                reactionEnvelope.fromId ??
                reactionEnvelope.author_id ??
                reactionEnvelope.authorId ??
                reactionEnvelope.sender_id ??
                reactionEnvelope.senderId ??
                reactionEnvelope.actor_id ??
                reactionEnvelope.actorId ??
                reactionEnvelope.sender_chat_id ??
                reactionEnvelope.senderChatId ??
                reactionEnvelope.actor_chat_id ??
                reactionEnvelope.actorChatId,
            ) ??
            parseNumericId(
              rawReactionEnvelope?.user_id ??
                rawReactionEnvelope?.userId ??
                rawReactionEnvelope?.from_user_id ??
                rawReactionEnvelope?.fromUserId ??
                rawReactionEnvelope?.author_user_id ??
                rawReactionEnvelope?.authorUserId ??
                rawReactionEnvelope?.sender_user_id ??
                rawReactionEnvelope?.senderUserId ??
                rawReactionEnvelope?.from_id ??
                rawReactionEnvelope?.fromId ??
                rawReactionEnvelope?.author_id ??
                rawReactionEnvelope?.authorId ??
                rawReactionEnvelope?.sender_id ??
                rawReactionEnvelope?.senderId ??
                rawReactionEnvelope?.actor_id ??
                rawReactionEnvelope?.actorId ??
                rawReactionEnvelope?.sender_chat_id ??
                rawReactionEnvelope?.senderChatId ??
                rawReactionEnvelope?.actor_chat_id ??
                rawReactionEnvelope?.actorChatId,
            );
          if (flattenedUserId == null) {
            return undefined;
          }
          return {
            id: flattenedUserId,
            username:
              reactionEnvelope.username ??
              reactionEnvelope.from_user_username ??
              reactionEnvelope.fromUserUsername ??
              reactionEnvelope.author_user_username ??
              reactionEnvelope.authorUserUsername ??
              reactionEnvelope.sender_user_username ??
              reactionEnvelope.senderUserUsername ??
              reactionEnvelope.from_username ??
              reactionEnvelope.fromUsername ??
              reactionEnvelope.author_username ??
              reactionEnvelope.authorUsername ??
              reactionEnvelope.sender_username ??
              reactionEnvelope.senderUsername ??
              reactionEnvelope.actor_username ??
              reactionEnvelope.actorUsername ??
              reactionEnvelope.sender_chat_username ??
              reactionEnvelope.senderChatUsername ??
              reactionEnvelope.actor_chat_username ??
              reactionEnvelope.actorChatUsername ??
              rawReactionEnvelope?.username ??
              rawReactionEnvelope?.from_user_username ??
              rawReactionEnvelope?.fromUserUsername ??
              rawReactionEnvelope?.author_user_username ??
              rawReactionEnvelope?.authorUserUsername ??
              rawReactionEnvelope?.sender_user_username ??
              rawReactionEnvelope?.senderUserUsername ??
              rawReactionEnvelope?.from_username ??
              rawReactionEnvelope?.fromUsername ??
              rawReactionEnvelope?.author_username ??
              rawReactionEnvelope?.authorUsername ??
              rawReactionEnvelope?.sender_username ??
              rawReactionEnvelope?.senderUsername ??
              rawReactionEnvelope?.actor_username ??
              rawReactionEnvelope?.actorUsername ??
              rawReactionEnvelope?.sender_chat_username ??
              rawReactionEnvelope?.senderChatUsername ??
              rawReactionEnvelope?.actor_chat_username ??
              rawReactionEnvelope?.actorChatUsername,
            is_bot:
              reactionEnvelope.is_bot ??
              reactionEnvelope.isBot ??
              rawReactionEnvelope?.is_bot ??
              rawReactionEnvelope?.isBot,
            first_name:
              reactionEnvelope.first_name ??
              reactionEnvelope.firstName ??
              reactionEnvelope.title ??
              reactionEnvelope.sender_chat_title ??
              reactionEnvelope.senderChatTitle ??
              reactionEnvelope.actor_chat_title ??
              reactionEnvelope.actorChatTitle ??
              rawReactionEnvelope?.first_name ??
              rawReactionEnvelope?.firstName ??
              rawReactionEnvelope?.title ??
              rawReactionEnvelope?.sender_chat_title ??
              rawReactionEnvelope?.senderChatTitle ??
              rawReactionEnvelope?.actor_chat_title ??
              rawReactionEnvelope?.actorChatTitle,
            last_name:
              reactionEnvelope.last_name ??
              reactionEnvelope.lastName ??
              rawReactionEnvelope?.last_name ??
              rawReactionEnvelope?.lastName,
          };
        })();
      const chatId = parseNumericId(reactionChat?.id);
      if (!reactionChat || chatId == null || messageId == null) {
        reactionPipelineDiag?.(
          `[telegram-reaction-diag] account=${accountId} stage=drop reason=missing-reaction-envelope hasChat=${Boolean(reactionChat)} hasChatId=${chatId != null} hasMessageId=${messageId != null}`,
        );
        return;
      }

      const typedUpdate = (ctx.update ?? {}) as Record<string, unknown>;
      const updateId = typeof typedUpdate.update_id === "number" ? String(typedUpdate.update_id) : "n/a";
      const senderId = user?.id != null ? String(user.id) : "";
      const senderUsername = user?.username ?? "";
      const isGroup = reactionChat.type === "group" || reactionChat.type === "supergroup";
      const isForum = reactionChat.is_forum === true;
      const reactionDiagPrefix = `[telegram-reaction-diag] account=${accountId} update_id=${updateId} chat=${chatId} msg=${messageId} sender=${senderId || "anon"}`;

      const skippedByUpdateGate = shouldSkipUpdate(ctx);
      reactionPipelineDiag?.(
        `${reactionDiagPrefix} stage=pre-skip skipped=${skippedByUpdateGate} hasParsedReaction=${Boolean(ctx.messageReaction)} hasRawReaction=${Boolean(ctx.update?.message_reaction)}`,
      );
      if (skippedByUpdateGate) {
        return;
      }

      // Resolve reaction notification mode (default: "own").
      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      reactionPipelineDiag?.(
        `${reactionDiagPrefix} stage=entry mode=${reactionMode} isGroup=${isGroup} isForum=${isForum}`,
      );
      if (reactionMode === "off") {
        reactionPipelineDiag?.(`${reactionDiagPrefix} stage=drop reason=mode-off`);
        return;
      }
      if (user?.is_bot) {
        const allowBotReactionForTesting =
          process.env.OPENCLAW_TELEGRAM_ALLOW_BOT_REACTION_TEST === "1";
        if (!allowBotReactionForTesting) {
          reactionPipelineDiag?.(`${reactionDiagPrefix} stage=drop reason=user-is-bot`);
          return;
        }
      }
      const ownMessage = telegramDeps.wasSentByBot(chatId, messageId);
      if (reactionMode === "own" && !ownMessage) {
        reactionPipelineDiag?.(`${reactionDiagPrefix} stage=drop reason=own-mode-not-bot-message`);
        logVerbose(
          `telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`,
        );
        return;
      }
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId,
        isGroup,
        isForum,
      });
      const missingSenderInDirectReaction = !isGroup && !senderId;
      const senderAuthorization: TelegramEventAuthorizationResult = missingSenderInDirectReaction
        ? { allowed: true }
        : authorizeTelegramEventSender({
            chatId,
            chatTitle: reactionChat.title,
            isGroup,
            senderId,
            senderUsername,
            mode: "reaction",
            context: eventAuthContext,
          });
      if (missingSenderInDirectReaction) {
        reactionPipelineDiag?.(
          `${reactionDiagPrefix} stage=auth-bypass reason=missing-sender-in-direct-reaction`,
        );
      }
      if (!senderAuthorization.allowed) {
        reactionPipelineDiag?.(`${reactionDiagPrefix} stage=auth-deny reason=${senderAuthorization.reason}`);
        return;
      }

      // Enforce requireTopic for DM reactions: since Telegram doesn't provide messageThreadId
      // for reactions, we cannot determine if the reaction came from a topic, so block all
      // reactions if requireTopic is enabled for this DM.
      if (!isGroup) {
        const requireTopic = (eventAuthContext.groupConfig as TelegramDirectConfig | undefined)
          ?.requireTopic;
        if (requireTopic === true) {
          reactionPipelineDiag?.(`${reactionDiagPrefix} stage=drop reason=direct-require-topic`);
          logVerbose(
            `Blocked telegram reaction in DM ${chatId}: requireTopic=true but topic unknown for reactions`,
          );
          return;
        }
      }

      // Detect added reactions (emoji + custom emoji).
      // Telegram updates are snake_case, but adapter paths may expose camelCase
      // reaction arrays. Normalize both shapes to avoid silent no-op drops.
      const parseReactionJson = (value: string): unknown | null => {
        let candidate = value.trim();
        for (let depth = 0; depth < 3; depth += 1) {
          const isJsonLike =
            candidate.startsWith("{") || candidate.startsWith("[") || candidate.startsWith('"');
          if (!isJsonLike) {
            return depth === 0 ? null : candidate;
          }
          try {
            const parsed = JSON.parse(candidate) as unknown;
            if (typeof parsed === "string") {
              candidate = parsed.trim();
              continue;
            }
            return parsed;
          } catch {
            return null;
          }
        }
        return candidate;
      };
      const normalizeReaction = (value: unknown): { key: string; display: string } | null => {
        if (typeof value === "string") {
          const parsed = parseReactionJson(value);
          if (parsed !== null) {
            const parsedReaction = normalizeReaction(parsed);
            if (parsedReaction) {
              return parsedReaction;
            }
          }
          const trimmed = value.trim();
          if (trimmed.length > 0) {
            return { key: `emoji:${trimmed}`, display: trimmed };
          }
          return null;
        }
        if (!value || typeof value !== "object") {
          return null;
        }
        const wrappedReaction = (value as {
          reaction?: unknown;
          reaction_type?: unknown;
          reactionType?: unknown;
        }).reaction ??
          (value as {
            reaction?: unknown;
            reaction_type?: unknown;
            reactionType?: unknown;
          }).reaction_type ??
          (value as {
            reaction?: unknown;
            reaction_type?: unknown;
            reactionType?: unknown;
          }).reactionType;
        if (wrappedReaction && wrappedReaction !== value) {
          const normalizedWrapped = normalizeReaction(wrappedReaction);
          if (normalizedWrapped) {
            return normalizedWrapped;
          }
        }
        const reactionValue = value as {
          type?: string;
          emoji?: string;
          emoticon?: string;
          unicode_emoji?: string;
          unicodeEmoji?: string;
          custom_emoji_id?: unknown;
          custom_emoji?: unknown;
          customEmojiId?: unknown;
          customEmoji?: unknown;
          paid?: boolean;
          is_paid?: boolean;
          isPaid?: boolean;
        };
        const normalizeId = (candidate: unknown): string | undefined => {
          if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            return trimmed.length > 0 ? trimmed : undefined;
          }
          if (typeof candidate === "number" && Number.isFinite(candidate)) {
            return String(candidate);
          }
          if (typeof candidate === "bigint") {
            return candidate.toString();
          }
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            const objectCandidate = candidate as {
              id?: unknown;
              value?: unknown;
              identifier?: unknown;
              custom_emoji_id?: unknown;
              custom_emoji?: unknown;
              customEmojiId?: unknown;
              customEmoji?: unknown;
            };
            const nestedCandidates = [
              objectCandidate.id,
              objectCandidate.value,
              objectCandidate.identifier,
              objectCandidate.custom_emoji_id,
              objectCandidate.custom_emoji,
              objectCandidate.customEmojiId,
              objectCandidate.customEmoji,
            ];
            for (const nestedCandidate of nestedCandidates) {
              if (nestedCandidate === candidate) {
                continue;
              }
              const normalizedNested = normalizeId(nestedCandidate);
              if (normalizedNested) {
                return normalizedNested;
              }
            }
          }
          return undefined;
        };
        const normalizeEmojiValue = (candidate: unknown): string | undefined => {
          if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            return trimmed.length > 0 ? trimmed : undefined;
          }
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            const emojiCandidate = candidate as {
              emoji?: unknown;
              emoticon?: unknown;
              unicode_emoji?: unknown;
              unicodeEmoji?: unknown;
              value?: unknown;
              text?: unknown;
              symbol?: unknown;
            };
            const nestedCandidates = [
              emojiCandidate.emoji,
              emojiCandidate.emoticon,
              emojiCandidate.unicode_emoji,
              emojiCandidate.unicodeEmoji,
              emojiCandidate.value,
              emojiCandidate.text,
              emojiCandidate.symbol,
            ];
            for (const nestedCandidate of nestedCandidates) {
              if (nestedCandidate === candidate) {
                continue;
              }
              const normalizedNested = normalizeEmojiValue(nestedCandidate);
              if (normalizedNested) {
                return normalizedNested;
              }
            }
          }
          return undefined;
        };
        const reactionType =
          typeof reactionValue.type === "string" && reactionValue.type.length > 0
            ? reactionValue.type
            : undefined;
        const normalizedReactionType = reactionType
          ?.toLowerCase()
          .replace(/[_-]/g, "");
        const isPaidReaction =
          normalizedReactionType === "paid" ||
          normalizedReactionType === "paidreaction" ||
          reactionValue.paid === true ||
          reactionValue.is_paid === true ||
          reactionValue.isPaid === true;
        if (isPaidReaction) {
          return { key: "paid", display: "paid" };
        }
        const emojiValue = normalizeEmojiValue(
          reactionValue.emoji ??
            reactionValue.emoticon ??
            reactionValue.unicode_emoji ??
            reactionValue.unicodeEmoji,
        );
        if (normalizedReactionType === "emoji" && emojiValue) {
          return { key: `emoji:${emojiValue}`, display: emojiValue };
        }
        const customEmojiId = normalizeId(
          reactionValue.custom_emoji_id ??
            reactionValue.custom_emoji ??
            reactionValue.customEmojiId ??
            reactionValue.customEmoji,
        );
        if (normalizedReactionType === "customemoji" && customEmojiId) {
          return {
            key: `custom_emoji:${customEmojiId}`,
            display: `custom_emoji:${customEmojiId}`,
          };
        }
        // Some adapter/runtime paths omit `type` while still carrying emoji/custom IDs.
        if (emojiValue) {
          return { key: `emoji:${emojiValue}`, display: emojiValue };
        }
        if (customEmojiId) {
          return {
            key: `custom_emoji:${customEmojiId}`,
            display: `custom_emoji:${customEmojiId}`,
          };
        }
        return null;
      };
      const reactionArrays = reaction as {
        old_reaction?: unknown;
        new_reaction?: unknown;
        from_reaction?: unknown;
        to_reaction?: unknown;
        old_value?: unknown;
        new_value?: unknown;
        from_value?: unknown;
        to_value?: unknown;
        before_value?: unknown;
        after_value?: unknown;
        before_state?: unknown;
        after_state?: unknown;
        prior_value?: unknown;
        latest_value?: unknown;
        previous_value?: unknown;
        current_value?: unknown;
        old_state?: unknown;
        new_state?: unknown;
        from_state?: unknown;
        to_state?: unknown;
        previous_state?: unknown;
        current_state?: unknown;
        prev_state?: unknown;
        next_state?: unknown;
        prior_state?: unknown;
        latest_state?: unknown;
        old_reactions?: unknown;
        new_reactions?: unknown;
        from_reactions?: unknown;
        to_reactions?: unknown;
        old_values?: unknown;
        new_values?: unknown;
        from_values?: unknown;
        to_values?: unknown;
        before_values?: unknown;
        after_values?: unknown;
        before_states?: unknown;
        after_states?: unknown;
        prior_values?: unknown;
        latest_values?: unknown;
        previous_values?: unknown;
        current_values?: unknown;
        old_states?: unknown;
        new_states?: unknown;
        from_states?: unknown;
        to_states?: unknown;
        previous_states?: unknown;
        current_states?: unknown;
        prev_states?: unknown;
        next_states?: unknown;
        prior_states?: unknown;
        latest_states?: unknown;
        before_reaction?: unknown;
        after_reaction?: unknown;
        before_reactions?: unknown;
        after_reactions?: unknown;
        previous_reaction?: unknown;
        current_reaction?: unknown;
        previous_reactions?: unknown;
        current_reactions?: unknown;
        before?: unknown;
        after?: unknown;
        previous?: unknown;
        current?: unknown;
        old?: unknown;
        new?: unknown;
        reaction?: unknown;
        reactions?: unknown;
        oldReaction?: unknown;
        newReaction?: unknown;
        fromReaction?: unknown;
        toReaction?: unknown;
        oldValue?: unknown;
        newValue?: unknown;
        fromValue?: unknown;
        toValue?: unknown;
        beforeValue?: unknown;
        afterValue?: unknown;
        priorValue?: unknown;
        latestValue?: unknown;
        beforeState?: unknown;
        afterState?: unknown;
        previousValue?: unknown;
        currentValue?: unknown;
        oldState?: unknown;
        newState?: unknown;
        fromState?: unknown;
        toState?: unknown;
        previousState?: unknown;
        currentState?: unknown;
        prevState?: unknown;
        nextState?: unknown;
        priorState?: unknown;
        latestState?: unknown;
        oldReactions?: unknown;
        newReactions?: unknown;
        fromReactions?: unknown;
        toReactions?: unknown;
        oldValues?: unknown;
        newValues?: unknown;
        fromValues?: unknown;
        toValues?: unknown;
        beforeValues?: unknown;
        afterValues?: unknown;
        priorValues?: unknown;
        latestValues?: unknown;
        beforeStates?: unknown;
        afterStates?: unknown;
        previousValues?: unknown;
        currentValues?: unknown;
        oldStates?: unknown;
        newStates?: unknown;
        fromStates?: unknown;
        toStates?: unknown;
        previousStates?: unknown;
        currentStates?: unknown;
        prevStates?: unknown;
        nextStates?: unknown;
        priorStates?: unknown;
        latestStates?: unknown;
        beforeReaction?: unknown;
        afterReaction?: unknown;
        beforeReactions?: unknown;
        afterReactions?: unknown;
        previousReaction?: unknown;
        currentReaction?: unknown;
        previousReactions?: unknown;
        currentReactions?: unknown;
      };
      const rawReactionArrays = rawReaction as
        | {
            old_reaction?: unknown;
            new_reaction?: unknown;
            from_reaction?: unknown;
            to_reaction?: unknown;
            old_value?: unknown;
            new_value?: unknown;
            from_value?: unknown;
            to_value?: unknown;
            before_value?: unknown;
            after_value?: unknown;
            before_state?: unknown;
            after_state?: unknown;
            previous_value?: unknown;
            current_value?: unknown;
            old_state?: unknown;
            new_state?: unknown;
            from_state?: unknown;
            to_state?: unknown;
            previous_state?: unknown;
            current_state?: unknown;
            prev_state?: unknown;
            next_state?: unknown;
            prior_state?: unknown;
            latest_state?: unknown;
            old_reactions?: unknown;
            new_reactions?: unknown;
            from_reactions?: unknown;
            to_reactions?: unknown;
            old_values?: unknown;
            new_values?: unknown;
            from_values?: unknown;
            to_values?: unknown;
            before_values?: unknown;
            after_values?: unknown;
            before_states?: unknown;
            after_states?: unknown;
            previous_values?: unknown;
            current_values?: unknown;
            old_states?: unknown;
            new_states?: unknown;
            from_states?: unknown;
            to_states?: unknown;
            previous_states?: unknown;
            current_states?: unknown;
            prev_states?: unknown;
            next_states?: unknown;
            prior_states?: unknown;
            latest_states?: unknown;
            before_reaction?: unknown;
            after_reaction?: unknown;
            before_reactions?: unknown;
            after_reactions?: unknown;
            previous_reaction?: unknown;
            current_reaction?: unknown;
            previous_reactions?: unknown;
            current_reactions?: unknown;
            before?: unknown;
            after?: unknown;
            previous?: unknown;
            current?: unknown;
            old?: unknown;
            new?: unknown;
            reaction?: unknown;
            reactions?: unknown;
            oldReaction?: unknown;
            newReaction?: unknown;
            fromReaction?: unknown;
            toReaction?: unknown;
            oldValue?: unknown;
            newValue?: unknown;
            fromValue?: unknown;
            toValue?: unknown;
            beforeValue?: unknown;
            afterValue?: unknown;
            beforeState?: unknown;
            afterState?: unknown;
            previousValue?: unknown;
            currentValue?: unknown;
            oldState?: unknown;
            newState?: unknown;
            fromState?: unknown;
            toState?: unknown;
            previousState?: unknown;
            currentState?: unknown;
            prevState?: unknown;
            nextState?: unknown;
            priorState?: unknown;
            latestState?: unknown;
            oldReactions?: unknown;
            newReactions?: unknown;
            fromReactions?: unknown;
            toReactions?: unknown;
            oldValues?: unknown;
            newValues?: unknown;
            fromValues?: unknown;
            toValues?: unknown;
            beforeValues?: unknown;
            afterValues?: unknown;
            beforeStates?: unknown;
            afterStates?: unknown;
            previousValues?: unknown;
            currentValues?: unknown;
            oldStates?: unknown;
            newStates?: unknown;
            fromStates?: unknown;
            toStates?: unknown;
            previousStates?: unknown;
            currentStates?: unknown;
            prevStates?: unknown;
            nextStates?: unknown;
            priorStates?: unknown;
            latestStates?: unknown;
            beforeReaction?: unknown;
            afterReaction?: unknown;
            beforeReactions?: unknown;
            afterReactions?: unknown;
            previousReaction?: unknown;
            currentReaction?: unknown;
            previousReactions?: unknown;
            currentReactions?: unknown;
          }
        | undefined;
      const coerceReactionArrayCandidate = (value: unknown): unknown[] | null => {
        const coerceIndexedObjectArray = (candidate: unknown): unknown[] | null => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            return null;
          }
          const indexedEntries = Object.entries(candidate as Record<string, unknown>)
            .filter(([key]) => /^\d+$/.test(key))
            .sort((a, b) => Number(a[0]) - Number(b[0]));
          if (indexedEntries.length === 0) {
            return null;
          }
          return indexedEntries.map(([, entry]) => entry);
        };
        const unwrapReactionArrayContainer = (candidate: unknown): unknown[] | null => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            return null;
          }
          const wrapped = candidate as {
            reactions?: unknown;
            reaction?: unknown;
            reaction_list?: unknown;
            reactionList?: unknown;
            items?: unknown;
            values?: unknown;
            message?: unknown;
            event?: unknown;
            update?: unknown;
            body?: unknown;
            content?: unknown;
            data?: unknown;
            payload?: unknown;
          };
          const nestedCandidates = [
            wrapped.reactions,
            wrapped.reaction,
            wrapped.reaction_list,
            wrapped.reactionList,
            wrapped.items,
            wrapped.values,
            wrapped.message,
            wrapped.event,
            wrapped.update,
            wrapped.body,
            wrapped.content,
            wrapped.data,
            wrapped.payload,
          ];
          for (const nestedCandidate of nestedCandidates) {
            if (nestedCandidate == null || nestedCandidate === candidate) {
              continue;
            }
            const coercedNested = coerceReactionArrayCandidate(nestedCandidate);
            if (coercedNested) {
              return coercedNested;
            }
          }
          return null;
        };
        if (Array.isArray(value)) {
          return value;
        }
        if (typeof value === "string") {
          const parsed = parseReactionJson(value);
          if (Array.isArray(parsed)) {
            return parsed;
          }
          const parsedIndexedArray = coerceIndexedObjectArray(parsed);
          if (parsedIndexedArray) {
            return parsedIndexedArray;
          }
          if (parsed !== null && normalizeReaction(parsed) !== null) {
            return [parsed];
          }
        }
        const indexedArray = coerceIndexedObjectArray(value);
        if (indexedArray) {
          return indexedArray;
        }
        const wrappedArray = unwrapReactionArrayContainer(value);
        if (wrappedArray) {
          return wrappedArray;
        }
        if (normalizeReaction(value) !== null) {
          return [value];
        }
        return null;
      };
      const resolveReactionArray = (...values: unknown[]): unknown[] => {
        let firstArray: unknown[] | null = null;
        let firstNonEmptyArray: unknown[] | null = null;
        for (const value of values) {
          const candidate = coerceReactionArrayCandidate(value);
          if (!candidate) {
            continue;
          }
          firstArray ??= candidate;
          if (candidate.length > 0) {
            firstNonEmptyArray ??= candidate;
            if (candidate.some((item) => normalizeReaction(item) !== null)) {
              return candidate;
            }
          }
        }
        return firstNonEmptyArray ?? firstArray ?? [];
      };
      const reactionAliasRecord = reaction as Record<string, unknown>;
      const rawReactionAliasRecord =
        rawReaction && typeof rawReaction === "object"
          ? (rawReaction as Record<string, unknown>)
          : undefined;
      const oldReactionValues = resolveReactionArray(
        reactionArrays.old_reaction,
        reactionArrays.from_reaction,
        reactionArrays.old_value,
        reactionArrays.from_value,
        reactionArrays.from_state,
        reactionArrays.before_value,
        reactionArrays.before_state,
        reactionArrays.prior_value,
        reactionArrays.previous_value,
        reactionArrays.old_state,
        reactionArrays.previous_state,
        reactionArrays.prev_state,
        reactionArrays.prior_state,
        reactionArrays.old_reactions,
        reactionArrays.from_reactions,
        reactionArrays.old_values,
        reactionArrays.from_values,
        reactionArrays.from_states,
        reactionArrays.before_values,
        reactionArrays.prior_values,
        reactionArrays.before_states,
        reactionArrays.previous_values,
        reactionArrays.old_states,
        reactionArrays.previous_states,
        reactionArrays.prev_states,
        reactionArrays.prior_states,
        reactionArrays.before_reaction,
        reactionArrays.before_reactions,
        reactionArrays.previous_reaction,
        reactionArrays.previous_reactions,
        reactionArrays.before,
        reactionArrays.old,
        reactionArrays.oldReaction,
        reactionArrays.fromReaction,
        reactionArrays.oldValue,
        reactionArrays.fromValue,
        reactionArrays.fromState,
        reactionArrays.beforeValue,
        reactionArrays.priorValue,
        reactionArrays.beforeState,
        reactionArrays.previousValue,
        reactionArrays.oldState,
        reactionArrays.previousState,
        reactionArrays.prevState,
        reactionArrays.priorState,
        reactionArrays.oldReactions,
        reactionArrays.fromReactions,
        reactionArrays.oldValues,
        reactionArrays.fromValues,
        reactionArrays.fromStates,
        reactionArrays.beforeValues,
        reactionArrays.priorValues,
        reactionArrays.beforeStates,
        reactionArrays.previousValues,
        reactionArrays.oldStates,
        reactionArrays.previousStates,
        reactionArrays.prevStates,
        reactionArrays.priorStates,
        reactionArrays.beforeReaction,
        reactionArrays.beforeReactions,
        reactionArrays.previousReaction,
        reactionArrays.previousReactions,
        reactionAliasRecord["prev_reaction"],
        reactionAliasRecord["prev_reactions"],
        reactionAliasRecord["prev_value"],
        reactionAliasRecord["prev_values"],
        reactionAliasRecord["prev_state"],
        reactionAliasRecord["prev_states"],
        reactionAliasRecord["prior_value"],
        reactionAliasRecord["prior_values"],
        reactionAliasRecord["prior_state"],
        reactionAliasRecord["prior_states"],
        reactionAliasRecord["prevReaction"],
        reactionAliasRecord["prevReactions"],
        reactionAliasRecord["prevValue"],
        reactionAliasRecord["prevValues"],
        reactionAliasRecord["prevState"],
        reactionAliasRecord["prevStates"],
        reactionAliasRecord["priorValue"],
        reactionAliasRecord["priorValues"],
        reactionAliasRecord["priorState"],
        reactionAliasRecord["priorStates"],
        reactionAliasRecord["source_reaction"],
        reactionAliasRecord["source_reactions"],
        reactionAliasRecord["source_value"],
        reactionAliasRecord["source_values"],
        reactionAliasRecord["source_state"],
        reactionAliasRecord["source_states"],
        reactionAliasRecord["sourceReaction"],
        reactionAliasRecord["sourceReactions"],
        reactionAliasRecord["sourceValue"],
        reactionAliasRecord["sourceValues"],
        reactionAliasRecord["sourceState"],
        reactionAliasRecord["sourceStates"],
        reactionAliasRecord.prev,
        reactionAliasRecord.prior,
        reactionAliasRecord.previous,
        reactionAliasRecord.source,
        rawReactionArrays?.old_reaction,
        rawReactionArrays?.from_reaction,
        rawReactionArrays?.old_value,
        rawReactionArrays?.from_value,
        rawReactionArrays?.from_state,
        rawReactionArrays?.before_value,
        rawReactionArrays?.before_state,
        rawReactionArrays?.prior_value,
        rawReactionArrays?.previous_value,
        rawReactionArrays?.old_state,
        rawReactionArrays?.previous_state,
        rawReactionArrays?.prev_state,
        rawReactionArrays?.prior_state,
        rawReactionArrays?.old_reactions,
        rawReactionArrays?.from_reactions,
        rawReactionArrays?.old_values,
        rawReactionArrays?.from_values,
        rawReactionArrays?.from_states,
        rawReactionArrays?.before_values,
        rawReactionArrays?.prior_values,
        rawReactionArrays?.before_states,
        rawReactionArrays?.previous_values,
        rawReactionArrays?.old_states,
        rawReactionArrays?.previous_states,
        rawReactionArrays?.prev_states,
        rawReactionArrays?.prior_states,
        rawReactionArrays?.before_reaction,
        rawReactionArrays?.before_reactions,
        rawReactionArrays?.previous_reaction,
        rawReactionArrays?.previous_reactions,
        rawReactionArrays?.before,
        rawReactionArrays?.old,
        rawReactionArrays?.oldReaction,
        rawReactionArrays?.fromReaction,
        rawReactionArrays?.oldValue,
        rawReactionArrays?.fromValue,
        rawReactionArrays?.fromState,
        rawReactionArrays?.beforeValue,
        rawReactionArrays?.priorValue,
        rawReactionArrays?.beforeState,
        rawReactionArrays?.previousValue,
        rawReactionArrays?.oldState,
        rawReactionArrays?.previousState,
        rawReactionArrays?.prevState,
        rawReactionArrays?.priorState,
        rawReactionArrays?.oldReactions,
        rawReactionArrays?.fromReactions,
        rawReactionArrays?.oldValues,
        rawReactionArrays?.fromValues,
        rawReactionArrays?.fromStates,
        rawReactionArrays?.beforeValues,
        rawReactionArrays?.priorValues,
        rawReactionArrays?.beforeStates,
        rawReactionArrays?.previousValues,
        rawReactionArrays?.oldStates,
        rawReactionArrays?.previousStates,
        rawReactionArrays?.prevStates,
        rawReactionArrays?.priorStates,
        rawReactionArrays?.beforeReaction,
        rawReactionArrays?.beforeReactions,
        rawReactionArrays?.previousReaction,
        rawReactionArrays?.previousReactions,
        rawReactionAliasRecord?.["prev_reaction"],
        rawReactionAliasRecord?.["prev_reactions"],
        rawReactionAliasRecord?.["prev_value"],
        rawReactionAliasRecord?.["prev_values"],
        rawReactionAliasRecord?.["prev_state"],
        rawReactionAliasRecord?.["prev_states"],
        rawReactionAliasRecord?.["prior_value"],
        rawReactionAliasRecord?.["prior_values"],
        rawReactionAliasRecord?.["prior_state"],
        rawReactionAliasRecord?.["prior_states"],
        rawReactionAliasRecord?.["prevReaction"],
        rawReactionAliasRecord?.["prevReactions"],
        rawReactionAliasRecord?.["prevValue"],
        rawReactionAliasRecord?.["prevValues"],
        rawReactionAliasRecord?.["prevState"],
        rawReactionAliasRecord?.["prevStates"],
        rawReactionAliasRecord?.["priorValue"],
        rawReactionAliasRecord?.["priorValues"],
        rawReactionAliasRecord?.["priorState"],
        rawReactionAliasRecord?.["priorStates"],
        rawReactionAliasRecord?.["source_reaction"],
        rawReactionAliasRecord?.["source_reactions"],
        rawReactionAliasRecord?.["source_value"],
        rawReactionAliasRecord?.["source_values"],
        rawReactionAliasRecord?.["source_state"],
        rawReactionAliasRecord?.["source_states"],
        rawReactionAliasRecord?.["sourceReaction"],
        rawReactionAliasRecord?.["sourceReactions"],
        rawReactionAliasRecord?.["sourceValue"],
        rawReactionAliasRecord?.["sourceValues"],
        rawReactionAliasRecord?.["sourceState"],
        rawReactionAliasRecord?.["sourceStates"],
        rawReactionAliasRecord?.prev,
        rawReactionAliasRecord?.prior,
        rawReactionAliasRecord?.previous,
        rawReactionAliasRecord?.source,
      );
      const newReactionValues = resolveReactionArray(
        reactionArrays.new_reaction,
        reactionArrays.to_reaction,
        reactionArrays.new_value,
        reactionArrays.to_value,
        reactionArrays.to_state,
        reactionArrays.after_value,
        reactionArrays.latest_value,
        reactionArrays.after_state,
        reactionArrays.current_value,
        reactionArrays.new_state,
        reactionArrays.current_state,
        reactionArrays.next_state,
        reactionArrays.latest_state,
        reactionArrays.new_reactions,
        reactionArrays.to_reactions,
        reactionArrays.new_values,
        reactionArrays.to_values,
        reactionArrays.to_states,
        reactionArrays.after_values,
        reactionArrays.latest_values,
        reactionArrays.after_states,
        reactionArrays.current_values,
        reactionArrays.new_states,
        reactionArrays.current_states,
        reactionArrays.next_states,
        reactionArrays.latest_states,
        reactionArrays.after_reaction,
        reactionArrays.after_reactions,
        reactionArrays.current_reaction,
        reactionArrays.current_reactions,
        reactionArrays.after,
        reactionArrays.new,
        reactionArrays.reaction,
        reactionArrays.reactions,
        reactionArrays.newReaction,
        reactionArrays.toReaction,
        reactionArrays.newValue,
        reactionArrays.toValue,
        reactionArrays.toState,
        reactionArrays.afterValue,
        reactionArrays.latestValue,
        reactionArrays.afterState,
        reactionArrays.currentValue,
        reactionArrays.newState,
        reactionArrays.currentState,
        reactionArrays.nextState,
        reactionArrays.latestState,
        reactionArrays.newReactions,
        reactionArrays.toReactions,
        reactionArrays.newValues,
        reactionArrays.toValues,
        reactionArrays.toStates,
        reactionArrays.afterValues,
        reactionArrays.latestValues,
        reactionArrays.afterStates,
        reactionArrays.currentValues,
        reactionArrays.newStates,
        reactionArrays.currentStates,
        reactionArrays.nextStates,
        reactionArrays.latestStates,
        reactionArrays.afterReaction,
        reactionArrays.afterReactions,
        reactionArrays.currentReaction,
        reactionArrays.currentReactions,
        reactionAliasRecord["next_reaction"],
        reactionAliasRecord["next_reactions"],
        reactionAliasRecord["next_value"],
        reactionAliasRecord["next_values"],
        reactionAliasRecord["next_state"],
        reactionAliasRecord["next_states"],
        reactionAliasRecord["latest_value"],
        reactionAliasRecord["latest_values"],
        reactionAliasRecord["latest_state"],
        reactionAliasRecord["latest_states"],
        reactionAliasRecord["nextReaction"],
        reactionAliasRecord["nextReactions"],
        reactionAliasRecord["nextValue"],
        reactionAliasRecord["nextValues"],
        reactionAliasRecord["nextState"],
        reactionAliasRecord["nextStates"],
        reactionAliasRecord["latestValue"],
        reactionAliasRecord["latestValues"],
        reactionAliasRecord["latestState"],
        reactionAliasRecord["latestStates"],
        reactionAliasRecord["target_reaction"],
        reactionAliasRecord["target_reactions"],
        reactionAliasRecord["target_value"],
        reactionAliasRecord["target_values"],
        reactionAliasRecord["target_state"],
        reactionAliasRecord["target_states"],
        reactionAliasRecord["targetReaction"],
        reactionAliasRecord["targetReactions"],
        reactionAliasRecord["targetValue"],
        reactionAliasRecord["targetValues"],
        reactionAliasRecord["targetState"],
        reactionAliasRecord["targetStates"],
        reactionAliasRecord.next,
        reactionAliasRecord.latest,
        reactionAliasRecord.current,
        reactionAliasRecord.target,
        rawReactionArrays?.new_reaction,
        rawReactionArrays?.to_reaction,
        rawReactionArrays?.new_value,
        rawReactionArrays?.to_value,
        rawReactionArrays?.to_state,
        rawReactionArrays?.after_value,
        rawReactionArrays?.latest_value,
        rawReactionArrays?.after_state,
        rawReactionArrays?.current_value,
        rawReactionArrays?.new_state,
        rawReactionArrays?.current_state,
        rawReactionArrays?.next_state,
        rawReactionArrays?.latest_state,
        rawReactionArrays?.new_reactions,
        rawReactionArrays?.to_reactions,
        rawReactionArrays?.new_values,
        rawReactionArrays?.to_values,
        rawReactionArrays?.to_states,
        rawReactionArrays?.after_values,
        rawReactionArrays?.latest_values,
        rawReactionArrays?.after_states,
        rawReactionArrays?.current_values,
        rawReactionArrays?.new_states,
        rawReactionArrays?.current_states,
        rawReactionArrays?.next_states,
        rawReactionArrays?.latest_states,
        rawReactionArrays?.after_reaction,
        rawReactionArrays?.after_reactions,
        rawReactionArrays?.current_reaction,
        rawReactionArrays?.current_reactions,
        rawReactionArrays?.after,
        rawReactionArrays?.new,
        rawReactionArrays?.reaction,
        rawReactionArrays?.reactions,
        rawReactionArrays?.newReaction,
        rawReactionArrays?.toReaction,
        rawReactionArrays?.newValue,
        rawReactionArrays?.toValue,
        rawReactionArrays?.toState,
        rawReactionArrays?.afterValue,
        rawReactionArrays?.latestValue,
        rawReactionArrays?.afterState,
        rawReactionArrays?.currentValue,
        rawReactionArrays?.newState,
        rawReactionArrays?.currentState,
        rawReactionArrays?.nextState,
        rawReactionArrays?.latestState,
        rawReactionArrays?.newReactions,
        rawReactionArrays?.toReactions,
        rawReactionArrays?.newValues,
        rawReactionArrays?.toValues,
        rawReactionArrays?.toStates,
        rawReactionArrays?.afterValues,
        rawReactionArrays?.latestValues,
        rawReactionArrays?.afterStates,
        rawReactionArrays?.currentValues,
        rawReactionArrays?.newStates,
        rawReactionArrays?.currentStates,
        rawReactionArrays?.nextStates,
        rawReactionArrays?.latestStates,
        rawReactionArrays?.afterReaction,
        rawReactionArrays?.afterReactions,
        rawReactionArrays?.currentReaction,
        rawReactionArrays?.currentReactions,
        rawReactionAliasRecord?.["next_reaction"],
        rawReactionAliasRecord?.["next_reactions"],
        rawReactionAliasRecord?.["next_value"],
        rawReactionAliasRecord?.["next_values"],
        rawReactionAliasRecord?.["next_state"],
        rawReactionAliasRecord?.["next_states"],
        rawReactionAliasRecord?.["latest_value"],
        rawReactionAliasRecord?.["latest_values"],
        rawReactionAliasRecord?.["latest_state"],
        rawReactionAliasRecord?.["latest_states"],
        rawReactionAliasRecord?.["nextReaction"],
        rawReactionAliasRecord?.["nextReactions"],
        rawReactionAliasRecord?.["nextValue"],
        rawReactionAliasRecord?.["nextValues"],
        rawReactionAliasRecord?.["nextState"],
        rawReactionAliasRecord?.["nextStates"],
        rawReactionAliasRecord?.["latestValue"],
        rawReactionAliasRecord?.["latestValues"],
        rawReactionAliasRecord?.["latestState"],
        rawReactionAliasRecord?.["latestStates"],
        rawReactionAliasRecord?.["target_reaction"],
        rawReactionAliasRecord?.["target_reactions"],
        rawReactionAliasRecord?.["target_value"],
        rawReactionAliasRecord?.["target_values"],
        rawReactionAliasRecord?.["target_state"],
        rawReactionAliasRecord?.["target_states"],
        rawReactionAliasRecord?.["targetReaction"],
        rawReactionAliasRecord?.["targetReactions"],
        rawReactionAliasRecord?.["targetValue"],
        rawReactionAliasRecord?.["targetValues"],
        rawReactionAliasRecord?.["targetState"],
        rawReactionAliasRecord?.["targetStates"],
        rawReactionAliasRecord?.next,
        rawReactionAliasRecord?.latest,
        rawReactionAliasRecord?.current,
        rawReactionAliasRecord?.target,
        // Some adapter/runtime paths flatten the current reaction directly onto
        // the message_reaction envelope (for example: { type, emoji }) without
        // wrapping it in new_reaction/reaction keys.
        reactionArrays,
        rawReactionArrays,
      );
      const previousReactions = oldReactionValues
        .map(normalizeReaction)
        .flatMap((r) => (r ? [r] : []));
      const oldReactionKeys = new Set(previousReactions.map((r) => r.key));
      const nextReactions = newReactionValues.map(normalizeReaction).flatMap((r) => (r ? [r] : []));
      const addedReactions = nextReactions.filter((r) => !oldReactionKeys.has(r.key));
      const noopFallbackReactions = nextReactions.length > 0 ? nextReactions : previousReactions;
      const effectiveAddedReactions =
        addedReactions.length > 0
          ? addedReactions
          : noopFallbackReactions.length > 0
            ? [noopFallbackReactions[noopFallbackReactions.length - 1]]
            : [];
      reactionPipelineDiag?.(
        `${reactionDiagPrefix} stage=added oldReactionCount=${oldReactionKeys.size} newCount=${newReactionValues.length} addedCount=${addedReactions.length} effectiveAddedCount=${effectiveAddedReactions.length} fallbackNoop=${addedReactions.length === 0 && effectiveAddedReactions.length > 0} added=${effectiveAddedReactions
          .map((r) => r.display)
          .join(",") || "none"}`,
      );

      const reactionTestMode = process.env.OPENCLAW_TELEGRAM_ALLOW_BOT_REACTION_TEST === "1";
      if (reactionTestMode) {
        runtime.info?.(
          `telegram reaction event received chat=${chatId} msg=${messageId} userBot=${Boolean(user?.is_bot)} added=${effectiveAddedReactions
            .map((r) => r.display)
            .join(",")}`,
        );
      }

      if (effectiveAddedReactions.length === 0) {
        reactionPipelineDiag?.(`${reactionDiagPrefix} stage=drop reason=no-added-reactions`);
        return;
      }

      // Build sender label.
      const senderName = user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
        : undefined;
      const senderUsernameLabel = user?.username ? `@${user.username}` : undefined;
      let senderLabel = senderName;
      if (senderName && senderUsernameLabel) {
        senderLabel = `${senderName} (${senderUsernameLabel})`;
      } else if (!senderName && senderUsernameLabel) {
        senderLabel = senderUsernameLabel;
      }
      if (!senderLabel && user?.id) {
        senderLabel = `id:${user.id}`;
      }
      senderLabel = senderLabel || "unknown";

      // Reactions target a specific message_id; the Telegram Bot API does not include
      // message_thread_id on MessageReactionUpdated, so we route to the chat-level
      // session (forum topic routing is not available for reactions).
      const resolvedThreadId = isForum
        ? resolveTelegramForumThreadId({ isForum, messageThreadId: undefined })
        : undefined;
      const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
      const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
      // Fresh config for bindings lookup; other routing inputs are payload-derived.
      const route = resolveAgentRoute({
        cfg: telegramDeps.loadConfig(),
        channel: "telegram",
        accountId,
        peer: { kind: isGroup ? "group" : "direct", id: peerId },
        parentPeer,
      });
      const sessionKey = route.sessionKey;
      reactionPipelineDiag?.(
        `${reactionDiagPrefix} stage=route session=${sessionKey ?? "default"} added=${effectiveAddedReactions
          .map((r) => r.display)
          .join(",")}`,
      );

      const reactionDeliveryContext = {
        channel: "telegram",
        to:
          resolvedThreadId != null
            ? `telegram:${chatId}:topic:${resolvedThreadId}`
            : `telegram:${chatId}`,
        accountId,
        ...(resolvedThreadId != null ? { threadId: resolvedThreadId } : {}),
      };

      // Enqueue system event for each added reaction.
      for (const r of effectiveAddedReactions) {
        const reactionValue = r.display;
        const contextKey = `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${r.key}`;
        const text = `Telegram reaction added: ${reactionValue} by ${senderLabel} on msg ${messageId}`;
        telegramDeps.enqueueSystemEvent(text, {
          sessionKey,
          contextKey,
          deliveryContext: reactionDeliveryContext,
        });
        logVerbose(`telegram: reaction event enqueued: ${text}`);
        reactionPipelineDiag?.(
          `${reactionDiagPrefix} stage=enqueued session=${sessionKey ?? "default"} reaction=${reactionValue} context=${contextKey} delivery_to=${reactionDeliveryContext.to} delivery_thread=${reactionDeliveryContext.threadId ?? "none"}`,
        );
      }

      // When reactionTrigger is enabled, wake the agent so the reaction
      // system events are processed as a standalone turn instead of
      // waiting for the next inbound message.
      const reactionTrigger = telegramCfg.reactionTrigger === true;
      if (reactionTrigger && effectiveAddedReactions.length > 0) {
        requestHeartbeatNow({
          reason: "telegram-reaction",
          sessionKey,
          coalesceMs: 500,
        });
        logVerbose(`telegram: reaction trigger woke agent for session ${sessionKey}`);
        reactionPipelineDiag?.(
          `${reactionDiagPrefix} stage=wake reason=telegram-reaction session=${sessionKey ?? "default"}`,
        );
        if (reactionTestMode) {
          runtime.info?.(`telegram reaction trigger woke agent for session ${sessionKey}`);
        }
      }
    } catch (err) {
      runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
    }
  });

  // Fallback for chats where Telegram emits message_reaction_count updates
  // without per-user message_reaction payloads.
  bot.on("message_reaction_count", async (ctx) => {
    try {
      const rawReactionCount =
        ctx.update?.message_reaction_count ??
        ((ctx.update as { messageReactionCount?: unknown } | undefined)?.messageReactionCount as
          | Record<string, unknown>
          | undefined);
      const reactionCount = ctx.messageReactionCount ?? rawReactionCount;
      if (!reactionCount) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const reactionCountEnvelope = reactionCount as {
        chat?: { id?: number; type?: string; is_forum?: boolean; title?: string };
        chat_id?: number | string;
        chatId?: number | string;
        chat_type?: string;
        chatType?: string;
        is_forum?: boolean;
        isForum?: boolean;
        chat_title?: string;
        chatTitle?: string;
        message_id?: number;
        messageId?: number;
        reactions?: unknown;
        reaction?: unknown;
      };
      const rawReactionCountEnvelope = rawReactionCount as
        | {
            chat?: { id?: number; type?: string; is_forum?: boolean; title?: string };
            chat_id?: number | string;
            chatId?: number | string;
            chat_type?: string;
            chatType?: string;
            is_forum?: boolean;
            isForum?: boolean;
            chat_title?: string;
            chatTitle?: string;
            message_id?: number;
            messageId?: number;
            reactions?: unknown;
            reaction?: unknown;
          }
        | undefined;
      const parseNumericId = (value: unknown): number | undefined => {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === "bigint") {
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) ? parsed : undefined;
        }
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
      };
      const reactionChat =
        reactionCountEnvelope.chat ??
        rawReactionCountEnvelope?.chat ??
        (() => {
          const flattenedChatId =
            parseNumericId(reactionCountEnvelope.chat_id ?? reactionCountEnvelope.chatId) ??
            parseNumericId(rawReactionCountEnvelope?.chat_id ?? rawReactionCountEnvelope?.chatId);
          if (flattenedChatId == null) {
            return undefined;
          }
          return {
            id: flattenedChatId,
            type:
              reactionCountEnvelope.chat_type ??
              reactionCountEnvelope.chatType ??
              rawReactionCountEnvelope?.chat_type ??
              rawReactionCountEnvelope?.chatType,
            is_forum:
              reactionCountEnvelope.is_forum ??
              reactionCountEnvelope.isForum ??
              rawReactionCountEnvelope?.is_forum ??
              rawReactionCountEnvelope?.isForum,
            title:
              reactionCountEnvelope.chat_title ??
              reactionCountEnvelope.chatTitle ??
              rawReactionCountEnvelope?.chat_title ??
              rawReactionCountEnvelope?.chatTitle,
          };
        })();
      const chatId = parseNumericId(reactionChat?.id);
      const messageId =
        parseNumericId(reactionCountEnvelope.message_id ?? reactionCountEnvelope.messageId) ??
        parseNumericId(rawReactionCountEnvelope?.message_id ?? rawReactionCountEnvelope?.messageId);
      if (!reactionChat || chatId == null || messageId == null) {
        reactionPipelineDiag?.(
          `[telegram-reaction-count-diag] account=${accountId} stage=drop reason=missing-reaction-envelope hasChat=${Boolean(
            reactionChat,
          )} hasChatId=${chatId != null} hasMessageId=${messageId != null}`,
        );
        return;
      }

      const isGroup = reactionChat.type === "group" || reactionChat.type === "supergroup";
      const isForum = reactionChat.is_forum === true;
      const reactionDiagPrefix = `[telegram-reaction-count-diag] account=${accountId} chat=${chatId} msg=${messageId}`;

      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      reactionPipelineDiag?.(
        `${reactionDiagPrefix} stage=entry mode=${reactionMode} isGroup=${isGroup} isForum=${isForum}`,
      );
      if (reactionMode === "off") {
        return;
      }
      if (reactionMode === "own" && !telegramDeps.wasSentByBot(chatId, messageId)) {
        return;
      }

      // Focused fallback: only DM reaction-count updates.
      if (isGroup) {
        return;
      }

      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId,
        isGroup,
        isForum,
      });
      if (eventAuthContext.dmPolicy === "disabled") {
        reactionPipelineDiag?.(`${reactionDiagPrefix} stage=auth-deny reason=direct-disabled`);
        return;
      }

      const requireTopic = (eventAuthContext.groupConfig as TelegramDirectConfig | undefined)
        ?.requireTopic;
      if (requireTopic === true) {
        logVerbose(
          `Blocked telegram reaction_count in DM ${chatId}: requireTopic=true but topic unknown for reactions`,
        );
        return;
      }

      const parseReactionEntriesJson = (value: string): unknown | null => {
        const trimmed = value.trim();
        if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
          return null;
        }
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          return null;
        }
      };
      const coerceReactionEntriesCandidate = (value: unknown): unknown[] | null => {
        const coerceIndexedObjectArray = (candidate: unknown): unknown[] | null => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            return null;
          }
          const indexedEntries = Object.entries(candidate as Record<string, unknown>)
            .filter(([key]) => /^\d+$/.test(key))
            .sort((a, b) => Number(a[0]) - Number(b[0]));
          if (indexedEntries.length === 0) {
            return null;
          }
          return indexedEntries.map(([, entry]) => entry);
        };
        if (Array.isArray(value)) {
          return value;
        }
        if (typeof value === "string") {
          const parsed = parseReactionEntriesJson(value);
          if (Array.isArray(parsed)) {
            return parsed;
          }
          const parsedIndexed = coerceIndexedObjectArray(parsed);
          if (parsedIndexed) {
            return parsedIndexed;
          }
          if (parsed && typeof parsed === "object") {
            return [parsed];
          }
          return null;
        }
        const indexed = coerceIndexedObjectArray(value);
        if (indexed) {
          return indexed;
        }
        if (value && typeof value === "object") {
          return [value];
        }
        return null;
      };
      const resolveReactionEntries = (...values: unknown[]): unknown[] => {
        let firstArray: unknown[] | null = null;
        let firstNonEmptyArray: unknown[] | null = null;
        for (const value of values) {
          const candidate = coerceReactionEntriesCandidate(value);
          if (!candidate) {
            continue;
          }
          firstArray ??= candidate;
          if (candidate.length > 0) {
            firstNonEmptyArray ??= candidate;
            return candidate;
          }
        }
        return firstNonEmptyArray ?? firstArray ?? [];
      };
      const reactionEntries = resolveReactionEntries(
        reactionCountEnvelope.reactions,
        reactionCountEnvelope.reaction,
        rawReactionCountEnvelope?.reactions,
        rawReactionCountEnvelope?.reaction,
      );
      const parseReactionCount = (value: unknown): number => {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === "bigint") {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : 0;
        }
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : 0;
        }
        return 0;
      };
      const normalizeReactionTypeLabel = (value: unknown): string | undefined => {
        if (typeof value !== "string") {
          return undefined;
        }
        const trimmed = value.trim();
        if (!trimmed) {
          return undefined;
        }
        return trimmed.toLowerCase().replace(/[_-]/g, "");
      };
      const normalizeCustomEmojiId = (candidate: unknown): string | undefined => {
        if (typeof candidate === "string") {
          const trimmed = candidate.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
          return String(candidate);
        }
        if (typeof candidate === "bigint") {
          return candidate.toString();
        }
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          const objectCandidate = candidate as {
            id?: unknown;
            value?: unknown;
            identifier?: unknown;
            custom_emoji_id?: unknown;
            custom_emoji?: unknown;
            customEmojiId?: unknown;
            customEmoji?: unknown;
          };
          const nestedCandidates = [
            objectCandidate.id,
            objectCandidate.value,
            objectCandidate.identifier,
            objectCandidate.custom_emoji_id,
            objectCandidate.custom_emoji,
            objectCandidate.customEmojiId,
            objectCandidate.customEmoji,
          ];
          for (const nestedCandidate of nestedCandidates) {
            if (nestedCandidate === candidate) {
              continue;
            }
            const normalizedNested = normalizeCustomEmojiId(nestedCandidate);
            if (normalizedNested) {
              return normalizedNested;
            }
          }
        }
        return undefined;
      };
      const normalizeReactionCountEmoji = (candidate: unknown): string | undefined => {
        if (typeof candidate === "string") {
          const trimmed = candidate.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          const objectCandidate = candidate as {
            emoji?: unknown;
            emoticon?: unknown;
            unicode_emoji?: unknown;
            unicodeEmoji?: unknown;
            value?: unknown;
            text?: unknown;
            symbol?: unknown;
          };
          const nestedCandidates = [
            objectCandidate.emoji,
            objectCandidate.emoticon,
            objectCandidate.unicode_emoji,
            objectCandidate.unicodeEmoji,
            objectCandidate.value,
            objectCandidate.text,
            objectCandidate.symbol,
          ];
          for (const nestedCandidate of nestedCandidates) {
            if (nestedCandidate === candidate) {
              continue;
            }
            const normalizedNested = normalizeReactionCountEmoji(nestedCandidate);
            if (normalizedNested) {
              return normalizedNested;
            }
          }
        }
        return undefined;
      };
      const unwrapReactionCountEntry = (entry: unknown): Record<string, unknown> => {
        if (!entry || typeof entry !== "object") {
          return {};
        }
        const objectEntry = entry as {
          reaction?: unknown;
          reaction_type?: unknown;
          reactionType?: unknown;
        };
        const wrappedReaction =
          objectEntry.reaction ?? objectEntry.reaction_type ?? objectEntry.reactionType;
        if (wrappedReaction && typeof wrappedReaction === "object" && !Array.isArray(wrappedReaction)) {
          return {
            ...(wrappedReaction as Record<string, unknown>),
            ...(entry as Record<string, unknown>),
          };
        }
        return entry as Record<string, unknown>;
      };
      const summaryParts = reactionEntries.map((entry) => {
        const typedEntry = unwrapReactionCountEntry(entry) as {
          type?: string;
          emoji?: string;
          emoticon?: string;
          unicode_emoji?: string;
          unicodeEmoji?: string;
          custom_emoji_id?: unknown;
          custom_emoji?: unknown;
          customEmojiId?: unknown;
          customEmoji?: unknown;
          paid?: boolean;
          is_paid?: boolean;
          isPaid?: boolean;
          total_count?: unknown;
          totalCount?: unknown;
        };
        const count = parseReactionCount(typedEntry.total_count ?? typedEntry.totalCount);
        const normalizedType = normalizeReactionTypeLabel(typedEntry.type);
        const emoji = normalizeReactionCountEmoji(
          typedEntry.emoji ??
            typedEntry.emoticon ??
            typedEntry.unicode_emoji ??
            typedEntry.unicodeEmoji,
        );
        const customEmojiRaw =
          typedEntry.custom_emoji_id ??
          typedEntry.custom_emoji ??
          typedEntry.customEmojiId ??
          typedEntry.customEmoji;
        const customEmojiId = normalizeCustomEmojiId(customEmojiRaw);
        const isPaidReaction =
          normalizedType === "paid" ||
          typedEntry.paid === true ||
          typedEntry.is_paid === true ||
          typedEntry.isPaid === true;
        if (normalizedType === "emoji" || (!normalizedType && emoji)) {
          return `${emoji ?? "emoji"}:${count}`;
        }
        if (
          normalizedType === "customemoji" ||
          (!normalizedType && typeof customEmojiId === "string")
        ) {
          return `custom:${customEmojiId ?? "unknown"}:${count}`;
        }
        if (isPaidReaction) {
          return `paid:${count}`;
        }
        const fallbackType =
          typeof typedEntry.type === "string" && typedEntry.type.length > 0
            ? typedEntry.type
            : "unknown";
        return `${fallbackType}:${count}`;
      });
      const summary = summaryParts.length > 0 ? summaryParts.join(",") : "none";

      const peerId = String(chatId);
      const parentPeer = buildTelegramParentPeer({
        isGroup,
        resolvedThreadId: undefined,
        chatId,
      });
      const route = resolveAgentRoute({
        cfg: telegramDeps.loadConfig(),
        channel: "telegram",
        accountId,
        peer: { kind: "direct", id: peerId },
        parentPeer,
      });
      const sessionKey = route.sessionKey;

      const contextKey = `telegram:reaction:count:${chatId}:${messageId}:${summary}`;
      const text = `Telegram reaction count changed on msg ${messageId}: ${summary}`;
      const reactionDeliveryContext = {
        channel: "telegram",
        to: `telegram:${chatId}`,
        accountId,
      };
      telegramDeps.enqueueSystemEvent(text, {
        sessionKey,
        contextKey,
        deliveryContext: reactionDeliveryContext,
      });
      reactionPipelineDiag?.(
        `${reactionDiagPrefix} stage=enqueued session=${sessionKey ?? "default"} summary=${summary} delivery_to=${reactionDeliveryContext.to}`,
      );

      if (telegramCfg.reactionTrigger === true) {
        requestHeartbeatNow({
          reason: "telegram-reaction",
          sessionKey,
          coalesceMs: 500,
        });
        reactionPipelineDiag?.(
          `${reactionDiagPrefix} stage=wake reason=telegram-reaction session=${sessionKey ?? "default"}`,
        );
      }
    } catch (err) {
      runtime.error?.(danger(`telegram reaction_count handler failed: ${String(err)}`));
    }
  });

  const processInboundMessage = async (params: {
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    resolvedThreadId?: number;
    dmThreadId?: number;
    storeAllowFrom: string[];
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
  }) => {
    const {
      ctx,
      msg,
      chatId,
      resolvedThreadId,
      dmThreadId,
      storeAllowFrom,
      sendOversizeWarning,
      oversizeLogMessage,
    } = params;

    // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
    // We buffer “near-limit” messages and append immediately-following parts.
    const text = typeof msg.text === "string" ? msg.text : undefined;
    const isCommandLike = (text ?? "").trim().startsWith("/");
    if (text && !isCommandLike) {
      const nowMs = Date.now();
      const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
      // Use resolvedThreadId for forum groups, dmThreadId for DM topics
      const threadId = resolvedThreadId ?? dmThreadId;
      const key = `text:${chatId}:${threadId ?? "main"}:${senderId}`;
      const existing = textFragmentBuffer.get(key);

      if (existing) {
        const last = existing.messages.at(-1);
        const lastMsgId = last?.msg.message_id;
        const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
        const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
        const timeGapMs = nowMs - lastReceivedAtMs;
        const canAppend =
          idGap > 0 &&
          idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
          timeGapMs >= 0 &&
          timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

        if (canAppend) {
          const currentTotalChars = existing.messages.reduce(
            (sum, m) => sum + (m.msg.text?.length ?? 0),
            0,
          );
          const nextTotalChars = currentTotalChars + text.length;
          if (
            existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
            nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
          ) {
            existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
            scheduleTextFragmentFlush(existing);
            return;
          }
        }

        // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        textFragmentProcessing = textFragmentProcessing
          .then(async () => {
            await flushTextFragments(existing);
          })
          .catch(() => undefined);
        await textFragmentProcessing;
      }

      const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
      if (shouldStart) {
        const entry: TextFragmentEntry = {
          key,
          messages: [{ msg, ctx, receivedAtMs: nowMs }],
          timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
        };
        textFragmentBuffer.set(key, entry);
        scheduleTextFragmentFlush(entry);
        return;
      }
    }

    // Media group handling - buffer multi-image messages
    const mediaGroupId = msg.media_group_id;
    if (mediaGroupId) {
      const existing = mediaGroupBuffer.get(mediaGroupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.messages.push({ msg, ctx });
        existing.timer = setTimeout(async () => {
          mediaGroupBuffer.delete(mediaGroupId);
          mediaGroupProcessing = mediaGroupProcessing
            .then(async () => {
              await processMediaGroup(existing);
            })
            .catch(() => undefined);
          await mediaGroupProcessing;
        }, mediaGroupTimeoutMs);
      } else {
        const entry: MediaGroupEntry = {
          messages: [{ msg, ctx }],
          timer: setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(entry);
              })
              .catch(() => undefined);
            await mediaGroupProcessing;
          }, mediaGroupTimeoutMs),
        };
        mediaGroupBuffer.set(mediaGroupId, entry);
      }
      return;
    }

    let media: Awaited<ReturnType<typeof resolveMedia>> = null;
    try {
      media = await resolveMedia({
        ctx,
        maxBytes: mediaMaxBytes,
        ...mediaRuntimeOptions,
      });
    } catch (mediaErr) {
      if (isMediaSizeLimitError(mediaErr)) {
        if (sendOversizeWarning) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_parameters: {
                  message_id: msg.message_id,
                  allow_sending_without_reply: true,
                },
              }),
          }).catch(() => {});
        }
        logger.warn({ chatId, error: String(mediaErr) }, oversizeLogMessage);
        return;
      }
      logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime,
        fn: () =>
          bot.api.sendMessage(chatId, "⚠️ Failed to download media. Please try again.", {
            reply_parameters: {
              message_id: msg.message_id,
              allow_sending_without_reply: true,
            },
          }),
      }).catch(() => {});
      return;
    }

    // Skip sticker-only messages where the sticker was skipped (animated/video)
    // These have no media and no text content to process.
    const hasText = Boolean(getTelegramTextParts(msg).text.trim());
    if (msg.sticker && !media && !hasText) {
      logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
      return;
    }

    const allMedia = media
      ? [
          {
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          },
        ]
      : [];
    const senderId = msg.from?.id ? String(msg.from.id) : "";
    const conversationThreadId = resolvedThreadId ?? dmThreadId;
    const conversationKey =
      conversationThreadId != null ? `${chatId}:topic:${conversationThreadId}` : String(chatId);
    const debounceLane = resolveTelegramDebounceLane(msg);
    const debounceKey = senderId
      ? buildTelegramInboundDebounceKey({
          accountId,
          conversationKey,
          senderId,
          debounceLane,
        })
      : null;
    await inboundDebouncer.enqueue({
      ctx,
      msg,
      allMedia,
      storeAllowFrom,
      receivedAtMs: Date.now(),
      debounceKey,
      debounceLane,
      botUsername: ctx.me?.username,
    });
  };
  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    const answerCallbackQuery =
      typeof (ctx as { answerCallbackQuery?: unknown }).answerCallbackQuery === "function"
        ? () => ctx.answerCallbackQuery()
        : () => bot.api.answerCallbackQuery(callback.id);
    // Answer immediately to prevent Telegram from retrying while we process
    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: answerCallbackQuery,
    }).catch(() => {});
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const editCallbackMessage = async (
        text: string,
        params?: Parameters<typeof bot.api.editMessageText>[3],
      ) => {
        const editTextFn = (ctx as { editMessageText?: unknown }).editMessageText;
        if (typeof editTextFn === "function") {
          return await ctx.editMessageText(text, params);
        }
        return await bot.api.editMessageText(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          text,
          params,
        );
      };
      const clearCallbackButtons = async () => {
        const emptyKeyboard = { inline_keyboard: [] };
        const replyMarkup = { reply_markup: emptyKeyboard };
        const editReplyMarkupFn = (ctx as { editMessageReplyMarkup?: unknown })
          .editMessageReplyMarkup;
        if (typeof editReplyMarkupFn === "function") {
          return await ctx.editMessageReplyMarkup(replyMarkup);
        }
        const apiEditReplyMarkupFn = (bot.api as { editMessageReplyMarkup?: unknown })
          .editMessageReplyMarkup;
        if (typeof apiEditReplyMarkupFn === "function") {
          return await bot.api.editMessageReplyMarkup(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            replyMarkup,
          );
        }
        // Fallback path for older clients that do not expose editMessageReplyMarkup.
        const messageText = callbackMessage.text ?? callbackMessage.caption;
        if (typeof messageText !== "string" || messageText.trim().length === 0) {
          return undefined;
        }
        return await editCallbackMessage(messageText, replyMarkup);
      };
      const editCallbackButtons = async (
        buttons: Array<
          Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
        >,
      ) => {
        const keyboard = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
        const replyMarkup = { reply_markup: keyboard };
        const editReplyMarkupFn = (ctx as { editMessageReplyMarkup?: unknown })
          .editMessageReplyMarkup;
        if (typeof editReplyMarkupFn === "function") {
          return await ctx.editMessageReplyMarkup(replyMarkup);
        }
        return await bot.api.editMessageReplyMarkup(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          replyMarkup,
        );
      };
      const deleteCallbackMessage = async () => {
        const deleteFn = (ctx as { deleteMessage?: unknown }).deleteMessage;
        if (typeof deleteFn === "function") {
          return await ctx.deleteMessage();
        }
        return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
      };
      const replyToCallbackChat = async (
        text: string,
        params?: Parameters<typeof bot.api.sendMessage>[2],
      ) => {
        const replyFn = (ctx as { reply?: unknown }).reply;
        if (typeof replyFn === "function") {
          return await ctx.reply(text, params);
        }
        return await bot.api.sendMessage(callbackMessage.chat.id, text, params);
      };

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const approvalCallback = parseExecApprovalCommandText(data);
      const isApprovalCallback = approvalCallback !== null;
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId,
      });
      const execApprovalButtonsEnabled =
        isApprovalCallback &&
        shouldEnableTelegramExecApprovalButtons({
          cfg,
          accountId,
          to: String(chatId),
        });
      if (!execApprovalButtonsEnabled) {
        if (inlineButtonsScope === "off") {
          return;
        }
        if (inlineButtonsScope === "dm" && isGroup) {
          return;
        }
        if (inlineButtonsScope === "group" && !isGroup) {
          return;
        }
      }

      const messageThreadId = callbackMessage.message_thread_id;
      const isForum = await resolveTelegramForumFlag({
        chatId,
        chatType: callbackMessage.chat.type,
        isGroup,
        isForum: callbackMessage.chat.is_forum,
        getChat,
      });
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId,
        isGroup,
        isForum,
        messageThreadId,
      });
      const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = (groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`,
        );
        return;
      }
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      const authorizationMode: TelegramEventAuthorizationMode =
        !isGroup || (!execApprovalButtonsEnabled && inlineButtonsScope === "allowlist")
          ? "callback-allowlist"
          : "callback-scope";
      const senderAuthorization = authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: authorizationMode,
        context: eventAuthContext,
      });
      if (!senderAuthorization.allowed) {
        return;
      }

      const callbackThreadId = resolvedThreadId ?? dmThreadId;
      const callbackConversationId =
        callbackThreadId != null ? `${chatId}:topic:${callbackThreadId}` : String(chatId);
      const pluginBindingApproval = parsePluginBindingApprovalCustomId(data);
      if (pluginBindingApproval) {
        const resolved = await resolvePluginConversationBindingApproval({
          approvalId: pluginBindingApproval.approvalId,
          decision: pluginBindingApproval.decision,
          senderId: senderId || undefined,
        });
        await clearCallbackButtons();
        await replyToCallbackChat(buildPluginBindingResolvedText(resolved));
        return;
      }
      const pluginCallback = await dispatchTelegramPluginInteractiveHandler({
        data,
        callbackId: callback.id,
        ctx: {
          accountId,
          callbackId: callback.id,
          conversationId: callbackConversationId,
          parentConversationId: callbackThreadId != null ? String(chatId) : undefined,
          senderId: senderId || undefined,
          senderUsername: senderUsername || undefined,
          threadId: callbackThreadId,
          isGroup,
          isForum,
          auth: {
            isAuthorizedSender: true,
          },
          callbackMessage: {
            messageId: callbackMessage.message_id,
            chatId: String(chatId),
            messageText: callbackMessage.text ?? callbackMessage.caption,
          },
        },
        respond: {
          reply: async ({ text, buttons }) => {
            await replyToCallbackChat(
              text,
              buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
            );
          },
          editMessage: async ({ text, buttons }) => {
            await editCallbackMessage(
              text,
              buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
            );
          },
          editButtons: async ({ buttons }) => {
            await editCallbackButtons(buttons);
          },
          clearButtons: async () => {
            await clearCallbackButtons();
          },
          deleteMessage: async () => {
            await deleteCallbackMessage();
          },
        },
      });
      if (pluginCallback.handled) {
        return;
      }

      const runtimeCfg = telegramDeps.loadConfig();
      if (approvalCallback) {
        const isPluginApproval = approvalCallback.approvalId.startsWith("plugin:");
        const pluginApprovalAuthorizedSender = isTelegramExecApprovalApprover({
          cfg: runtimeCfg,
          accountId,
          senderId,
        });
        const execApprovalAuthorizedSender = isTelegramExecApprovalAuthorizedSender({
          cfg: runtimeCfg,
          accountId,
          senderId,
        });
        const authorizedApprovalSender = isPluginApproval
          ? pluginApprovalAuthorizedSender
          : execApprovalAuthorizedSender || pluginApprovalAuthorizedSender;
        if (!authorizedApprovalSender) {
          logVerbose(
            `Blocked telegram approval callback from ${senderId || "unknown"} (not authorized)`,
          );
          return;
        }
        try {
          // Resolve approval callbacks directly so Telegram approvers are not forced through
          // the generic chat-command authorization path.
          await (telegramDeps.resolveExecApproval ?? resolveTelegramExecApproval)({
            cfg: runtimeCfg,
            approvalId: approvalCallback.approvalId,
            decision: approvalCallback.decision,
            senderId,
            allowPluginFallback: pluginApprovalAuthorizedSender,
          });
        } catch (resolveErr) {
          const errStr = String(resolveErr);
          logVerbose(
            `telegram: failed to resolve approval callback ${approvalCallback.approvalId}: ${errStr}`,
          );
          await replyToCallbackChat(
            "❌ Failed to submit approval. Please try again or contact an admin.",
          );
          return;
        }
        try {
          await clearCallbackButtons();
        } catch (editErr) {
          const errStr = String(editErr);
          if (
            errStr.includes("message is not modified") ||
            errStr.includes("there is no text in the message to edit")
          ) {
            return;
          }
          logVerbose(`telegram: failed to clear approval callback buttons: ${errStr}`);
        }
        return;
      }

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }

        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) {
          return;
        }

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(runtimeCfg);
        const skillCommands = telegramDeps.listSkillCommandsForAgents({
          cfg: runtimeCfg,
          agentIds: [agentId],
        });
        const result = buildCommandsMessagePaginated(runtimeCfg, skillCommands, {
          page,
          forcePaginatedList: true,
          surface: "telegram",
        });

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : undefined);
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
        return;
      }

      // Model selection callback handler (mdl_prov, mdl_list_*, mdl_sel_*, mdl_back)
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        const sessionState = resolveTelegramSessionState({
          chatId,
          isGroup,
          isForum,
          messageThreadId,
          resolvedThreadId,
          senderId,
        });
        const modelData = await telegramDeps.buildModelsProviderData(
          runtimeCfg,
          sessionState.agentId,
        );
        const { byProvider, providers } = modelData;

        const editMessageWithButtons = async (
          text: string,
          buttons: ReturnType<typeof buildProviderKeyboard>,
          extra?: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2" },
        ) => {
          const keyboard = buildInlineKeyboard(buttons);
          const editParams = keyboard ? { reply_markup: keyboard, ...extra } : extra;
          try {
            await editCallbackMessage(text, editParams);
          } catch (editErr) {
            const errStr = String(editErr);
            if (errStr.includes("no text in the message")) {
              try {
                await deleteCallbackMessage();
              } catch {}
              await replyToCallbackChat(
                text,
                keyboard ? { reply_markup: keyboard, ...extra } : extra,
              );
            } else if (!errStr.includes("message is not modified")) {
              throw editErr;
            }
          }
        };

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            await editMessageWithButtons("No providers available.", []);
            return;
          }
          const providerInfos: ProviderInfo[] = providers.map((p) => ({
            id: p,
            count: byProvider.get(p)?.size ?? 0,
          }));
          const buttons = buildProviderKeyboard(providerInfos);
          await editMessageWithButtons("Select a provider:", buttons);
          return;
        }

        if (modelCallback.type === "list") {
          const { provider, page } = modelCallback;
          const modelSet = byProvider.get(provider);
          if (!modelSet || modelSet.size === 0) {
            // Provider not found or no models - show providers list
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildProviderKeyboard(providerInfos);
            await editMessageWithButtons(
              `Unknown provider: ${provider}\n\nSelect a provider:`,
              buttons,
            );
            return;
          }
          const models = [...modelSet].toSorted();
          const pageSize = getModelsPageSize();
          const totalPages = calculateTotalPages(models.length, pageSize);
          const safePage = Math.max(1, Math.min(page, totalPages));

          // Resolve current model from session (prefer overrides)
          const currentSessionState = resolveTelegramSessionState({
            chatId,
            isGroup,
            isForum,
            messageThreadId,
            resolvedThreadId,
            senderId,
          });
          const currentModel = currentSessionState.model;

          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            pageSize,
          });
          const text = formatModelsAvailableHeader({
            provider,
            total: models.length,
            cfg,
            agentDir: resolveAgentDir(cfg, currentSessionState.agentId),
            sessionEntry: currentSessionState.sessionEntry,
          });
          await editMessageWithButtons(text, buttons);
          return;
        }

        if (modelCallback.type === "select") {
          const selection = resolveModelSelection({
            callback: modelCallback,
            providers,
            byProvider,
          });
          if (selection.kind !== "resolved") {
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildProviderKeyboard(providerInfos);
            await editMessageWithButtons(
              `Could not resolve model "${selection.model}".\n\nSelect a provider:`,
              buttons,
            );
            return;
          }

          const modelSet = byProvider.get(selection.provider);
          if (!modelSet?.has(selection.model)) {
            await editMessageWithButtons(
              `❌ Model "${selection.provider}/${selection.model}" is not allowed.`,
              [],
            );
            return;
          }

          // Directly set model override in session
          try {
            // Get session store path
            const storePath = telegramDeps.resolveStorePath(cfg.session?.store, {
              agentId: sessionState.agentId,
            });

            const resolvedDefault = resolveDefaultModelForAgent({
              cfg,
              agentId: sessionState.agentId,
            });
            const isDefaultSelection =
              selection.provider === resolvedDefault.provider &&
              selection.model === resolvedDefault.model;

            await updateSessionStore(storePath, (store) => {
              const sessionKey = sessionState.sessionKey;
              const entry = store[sessionKey] ?? {};
              store[sessionKey] = entry;
              applyModelOverrideToSessionEntry({
                entry,
                selection: {
                  provider: selection.provider,
                  model: selection.model,
                  isDefault: isDefaultSelection,
                },
              });
            });

            // Update message to show success with visual feedback
            const escapeHtml = (text: string) =>
              text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const actionText = isDefaultSelection
              ? "reset to default"
              : `changed to <b>${escapeHtml(selection.provider)}/${escapeHtml(selection.model)}</b>`;
            await editMessageWithButtons(
              `✅ Model ${actionText}\n\nThis model will be used for your next message.`,
              [], // Empty buttons = remove inline keyboard
              { parse_mode: "HTML" },
            );
          } catch (err) {
            await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
          }
          return;
        }

        return;
      }

      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const syntheticMessage = buildSyntheticTextMessage({
        base: withResolvedTelegramForumFlag(callbackMessage, isForum),
        from: callback.from,
        text: nativeCallbackCommand ?? data,
      });
      await processMessage(buildSyntheticContext(ctx, syntheticMessage), [], storeAllowFrom, {
        ...(nativeCallbackCommand ? { commandSource: "native" as const } : {}),
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = msg.chat.title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = telegramDeps.loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
    }
  });

  type InboundTelegramEvent = {
    ctxForDedupe: TelegramUpdateKeyContext;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    senderId: string;
    senderUsername: string;
    requireConfiguredGroup: boolean;
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
    errorMessage: string;
  };

  const handleInboundMessageLike = async (event: InboundTelegramEvent) => {
    try {
      if (shouldSkipUpdate(event.ctxForDedupe)) {
        return;
      }
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        messageThreadId: event.messageThreadId,
      });
      const {
        dmPolicy,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        groupAllowOverride,
        effectiveGroupAllow,
        hasGroupAllowOverride,
      } = eventAuthContext;
      // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
      const dmAllowFrom = groupAllowOverride ?? allowFrom;
      const effectiveDmAllow = normalizeDmAllowFromWithStore({
        allowFrom: dmAllowFrom,
        storeAllowFrom,
        dmPolicy,
      });

      if (event.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
        logVerbose(`Blocked telegram channel ${event.chatId} (channel disabled)`);
        return;
      }

      if (
        shouldSkipGroupMessage({
          isGroup: event.isGroup,
          chatId: event.chatId,
          chatTitle: event.msg.chat.title,
          resolvedThreadId,
          senderId: event.senderId,
          senderUsername: event.senderUsername,
          effectiveGroupAllow,
          hasGroupAllowOverride,
          groupConfig,
          topicConfig,
        })
      ) {
        return;
      }

      if (!event.isGroup && (hasInboundMedia(event.msg) || hasReplyTargetMedia(event.msg))) {
        const dmAuthorized = await enforceTelegramDmAccess({
          isGroup: event.isGroup,
          dmPolicy,
          msg: event.msg,
          chatId: event.chatId,
          effectiveDmAllow,
          accountId,
          bot,
          logger,
          upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
        });
        if (!dmAuthorized) {
          return;
        }
      }

      await processInboundMessage({
        ctx: event.ctx,
        msg: event.msg,
        chatId: event.chatId,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        sendOversizeWarning: event.sendOversizeWarning,
        oversizeLogMessage: event.oversizeLogMessage,
      });
    } catch (err) {
      runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
    }
  };

  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg) {
      return;
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      getChat,
    });
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    // Bot-authored message updates can be echoed back by Telegram. Skip them here
    // and rely on the dedicated channel_post handler for channel-originated posts.
    if (normalizedMsg.from?.id != null && normalizedMsg.from.id === ctx.me?.id) {
      return;
    }
    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, normalizedMsg),
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      messageThreadId: normalizedMsg.message_thread_id,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      senderUsername: normalizedMsg.from?.username ?? "",
      requireConfiguredGroup: false,
      sendOversizeWarning: true,
      oversizeLogMessage: "media exceeds size limit",
      errorMessage: "handler failed",
    });
  });

  // Handle channel posts — enables bot-to-bot communication via Telegram channels.
  // Telegram bots cannot see other bot messages in groups, but CAN in channels.
  // This handler normalizes channel_post updates into the standard message pipeline.
  bot.on("channel_post", async (ctx) => {
    const post = ctx.channelPost;
    if (!post) {
      return;
    }

    const chatId = post.chat.id;
    const syntheticFrom = post.sender_chat
      ? {
          id: post.sender_chat.id,
          is_bot: true as const,
          first_name: post.sender_chat.title || "Channel",
          username: post.sender_chat.username,
        }
      : {
          id: chatId,
          is_bot: true as const,
          first_name: post.chat.title || "Channel",
          username: post.chat.username,
        };
    const syntheticMsg: Message = {
      ...post,
      from: post.from ?? syntheticFrom,
      chat: {
        ...post.chat,
        type: "supergroup" as const,
      },
    } as Message;

    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, syntheticMsg),
      msg: syntheticMsg,
      chatId,
      isGroup: true,
      isForum: false,
      senderId:
        post.sender_chat?.id != null
          ? String(post.sender_chat.id)
          : post.from?.id != null
            ? String(post.from.id)
            : "",
      senderUsername: post.sender_chat?.username ?? post.from?.username ?? "",
      requireConfiguredGroup: true,
      sendOversizeWarning: false,
      oversizeLogMessage: "channel post media exceeds size limit",
      errorMessage: "channel_post handler failed",
    });
  });
};
