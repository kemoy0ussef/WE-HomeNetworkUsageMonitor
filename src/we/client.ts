import { WeApiError } from "./errors.js";
import type {
  ApiResponse,
  AuthenticateResponseBody,
  CaptchaChallenge,
  CaptchaChallengeHandler,
  FetchUsageResult,
  FreeUnitItem,
  GenerateCaptchaResponse,
  QuerySysParamsBody,
  QuotaSnapshot,
  SubscribedOfferingsBody,
  WeAuthSession,
} from "./types.js";

const ECHANNEL_ORIGIN = "https://my.te.eg";
const ECHANNEL_ENTRY_URL = `${ECHANNEL_ORIGIN}/echannel/`;
const API_BASE_URL = `${ECHANNEL_ORIGIN}/echannel/service/besapp/base/rest/busiservice`;

const DEFAULT_CAPTCHA_URL = "https://captcha.te.eg/api/Captcha/GenerateCaptcha";
const DEFAULT_CAPTCHA_MERCHANT = "E-Care";
const DEFAULT_CHANNEL_ID = "702";
const DEFAULT_LOCALE = "en-US";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CAPTCHA_ATTEMPTS = 5;

const CAPTCHA_RETRY_ERROR_CODES = new Set([
  "60301025072100001",
  "60301025072100002",
  "60301025072100004",
  "603010110401155",
]);

const DATA_IMAGE_URI_PATTERN =
  /^data:image\/(?<subtype>[a-zA-Z0-9+.-]+);base64,(?<payload>[\s\S]+)$/u;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Measure unit codes from my.te.eg RESOURCE_MEASURE_UNIT enum:
// 1106 = Bytes, 1107 = KB, 1108 = MB, 1109 = GB
const UNIT_DIVISOR_TO_GB: Record<string, number> = {
  "1106": 1024 * 1024 * 1024,
  "1107": 1024 * 1024,
  "1108": 1024,
  "1109": 1,
};

export interface WeClientCredentials {
  serviceNumber: string;
  password: string;
}

export interface FetchHomeUsageOptions {
  onCaptchaChallenge?: CaptchaChallengeHandler;
}

export interface NormalizedServiceNumber {
  captchaIdentifier: string;
  acctId: string;
}

/**
 * Normalizes a WE Home Internet (FBB) landline/service number into the two formats
 * expected by `GenerateCaptcha` (`0...`) and `userAuthenticate` (`FBB...`).
 */
export function normalizeServiceNumber(
  rawServiceNumber: string
): NormalizedServiceNumber {
  const trimmed = rawServiceNumber.trim();
  if (trimmed.length === 0) {
    throw new Error("SERVICE_NUMBER must not be empty");
  }

  if (trimmed.toUpperCase().startsWith("FBB")) {
    const core = trimmed.slice(3).replace(/^0+/u, "");
    return {
      acctId: `FBB${core}`,
      captchaIdentifier: `0${core}`,
    };
  }

  const withoutLeadingZeros = trimmed.replace(/^0+/u, "");
  return {
    acctId: `FBB${withoutLeadingZeros}`,
    captchaIdentifier: trimmed.startsWith("0")
      ? trimmed
      : `0${withoutLeadingZeros}`,
  };
}

function parseCaptchaImagePayload(rawCaptcha: string): {
  imageBytes: Uint8Array;
  mimeExtension: string;
} {
  const trimmed = rawCaptcha.trim();
  const match = DATA_IMAGE_URI_PATTERN.exec(trimmed);

  let mimeExtension = "png";
  let base64Payload = trimmed;

  if (match?.groups) {
    const { subtype, payload } = match.groups;
    if (subtype) {
      mimeExtension = subtype.toLowerCase() === "jpeg" ? "jpg" : subtype;
    }
    if (payload) {
      base64Payload = payload;
    }
  }

  const buffer = Buffer.from(base64Payload, "base64");
  if (buffer.length === 0) {
    throw new Error("Decoded CAPTCHA image payload is empty");
  }

  return {
    imageBytes: new Uint8Array(buffer),
    mimeExtension,
  };
}

function convertToGb(amount: number, measureUnit: string): number {
  const divisor = UNIT_DIVISOR_TO_GB[measureUnit];
  if (divisor === undefined) {
    return amount;
  }
  return amount / divisor;
}

function toValidDate(epochMs: number | undefined): Date | null {
  if (epochMs === undefined || !Number.isFinite(epochMs)) {
    return null;
  }
  return new Date(epochMs);
}

function parseSetCookiePair(
  rawHeader: string
): { name: string; value: string } | null {
  const [firstSegment] = rawHeader.split(";");
  if (!firstSegment) {
    return null;
  }
  const eqIdx = firstSegment.indexOf("=");
  if (eqIdx <= 0) {
    return null;
  }
  return {
    name: firstSegment.slice(0, eqIdx).trim(),
    value: firstSegment.slice(eqIdx + 1).trim(),
  };
}

export class WeApiClient {
  readonly #cookies = new Map<string, string>();
  #bootstrapped = false;
  #csrfToken = "";
  #captchaUrl = DEFAULT_CAPTCHA_URL;
  #captchaMerchant = DEFAULT_CAPTCHA_MERCHANT;

  async bootstrap(): Promise<void> {
    const landingResponse = await fetch(ECHANNEL_ENTRY_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.#captureCookies(landingResponse);
    this.#bootstrapped = true;

    const paramsBody = await this.#postBes<
      { paramsList: string[] },
      QuerySysParamsBody
    >("/v1/common/querySysParams", {
      paramsList: ["we.captcha.load.url", "we.captcha.merchant"],
    });

    for (const item of paramsBody.paramsList) {
      if (item.key === "we.captcha.load.url" && item.value) {
        this.#captchaUrl = item.value;
      } else if (item.key === "we.captcha.merchant" && item.value) {
        this.#captchaMerchant = item.value;
      }
    }
  }

  async authenticate(
    credentials: WeClientCredentials,
    onCaptchaChallenge?: CaptchaChallengeHandler
  ): Promise<WeAuthSession> {
    if (!this.#bootstrapped) {
      await this.bootstrap();
    }

    const { acctId, captchaIdentifier } = normalizeServiceNumber(
      credentials.serviceNumber
    );

    return this.#authenticateWithCaptcha(
      acctId,
      credentials.password.trim(),
      captchaIdentifier,
      onCaptchaChallenge,
      1
    );
  }

  async getMainOfferId(session: WeAuthSession): Promise<string | undefined> {
    const offeringsBody = await this.#postBes<
      { msisdn: string; numberServiceType: string; groupId: string },
      SubscribedOfferingsBody
    >("/cz/v1/auth/getSubscribedOfferings", {
      msisdn: session.serviceNumber,
      numberServiceType: "FBB",
      groupId: "",
    });

    const mainOffer = offeringsBody.offeringList?.find(
      (offering) => offering.main === true
    );
    return mainOffer?.offerId ?? mainOffer?.mainOfferingId;
  }

  async queryFreeUnit(
    session: WeAuthSession,
    mainOfferId?: string
  ): Promise<QuotaSnapshot[]> {
    const payload: {
      subscriberId: string;
      needQueryPoint: boolean;
      mainOfferId?: string;
    } = {
      subscriberId: session.subscriberId,
      needQueryPoint: true,
    };

    if (mainOfferId !== undefined) {
      payload.mainOfferId = mainOfferId;
    }

    const freeUnits = await this.#postBes<typeof payload, FreeUnitItem[]>(
      "/cz/cbs/bb/queryFreeUnit",
      payload
    );

    if (!Array.isArray(freeUnits) || freeUnits.length === 0) {
      throw new Error("queryFreeUnit returned no usage records");
    }

    return freeUnits.map((item) => {
      const details = item.freeUnitBeanDetailList ?? [];
      const [firstDetail] = details;
      return {
        serviceNumber: firstDetail?.serviceNumber ?? session.serviceNumber,
        subscriberId: session.subscriberId,
        offerName: item.offerName,
        freeUnitType: item.freeUnitType,
        freeUnitTypeId: item.freeUnitTypeId,
        measureUnit: item.measureUnit,
        totalGb: convertToGb(item.total, item.measureUnit),
        usedGb: convertToGb(item.used, item.measureUnit),
        remainingGb: convertToGb(item.remain, item.measureUnit),
        actualRemainingGb: convertToGb(item.actualRemain, item.measureUnit),
        effectiveAt: toValidDate(item.effectiveTime),
        expiresAt: toValidDate(item.expireTime),
        remainingDaysForRenewal: firstDetail?.remainingDaysForRenewal ?? null,
        rawDetails: details,
      };
    });
  }

  async logout(): Promise<void> {
    if (this.#csrfToken.length === 0) {
      return;
    }
    try {
      await this.#postBes<{ custType: string; logoutType: string }, unknown>(
        "/v1/auth/logOutForUser",
        {
          custType: "INDIVIDUAL",
          logoutType: "0",
        }
      );
    } finally {
      this.#csrfToken = "";
    }
  }

  async #authenticateWithCaptcha(
    acctId: string,
    password: string,
    captchaIdentifier: string,
    onCaptchaChallenge: CaptchaChallengeHandler | undefined,
    attempt: number
  ): Promise<WeAuthSession> {
    const { imgCacheKey, imgCode } = await this.#resolvePreAuthToken(
      captchaIdentifier,
      onCaptchaChallenge
    );

    const payload: Record<string, string> = {
      acctId,
      password,
      appLocale: DEFAULT_LOCALE,
      isSelfcare: "Y",
      isMobile: "N",
      imgCacheKey,
      isConvergent: "0",
    };

    if (imgCode !== undefined) {
      payload.imgCode = imgCode;
    }

    try {
      const authBody = await this.#postBes<
        Record<string, string>,
        AuthenticateResponseBody
      >("/v1/auth/userAuthenticate", payload);

      if (!authBody.token || !authBody.subscriber?.subscriberId) {
        throw new Error(
          "Authentication succeeded without expected session token or subscriberId"
        );
      }

      this.#csrfToken = authBody.token;

      return {
        token: authBody.token,
        subscriberId: authBody.subscriber.subscriberId,
        serviceNumber: authBody.subscriber.servNumber || acctId,
        accountId: authBody.account?.acctId ?? "",
      };
    } catch (error) {
      const isRetryableCaptchaError =
        error instanceof WeApiError &&
        error.errorNo !== undefined &&
        CAPTCHA_RETRY_ERROR_CODES.has(error.errorNo);

      if (
        isRetryableCaptchaError &&
        onCaptchaChallenge !== undefined &&
        attempt < MAX_CAPTCHA_ATTEMPTS
      ) {
        console.warn(
          `CAPTCHA code rejected (${error.errorNo}). Requesting a new CAPTCHA (attempt ${attempt + 1}/${MAX_CAPTCHA_ATTEMPTS})...`
        );
        return this.#authenticateWithCaptcha(
          acctId,
          password,
          captchaIdentifier,
          onCaptchaChallenge,
          attempt + 1
        );
      }

      throw error;
    }
  }

  async #resolvePreAuthToken(
    identifier: string,
    onCaptchaChallenge: CaptchaChallengeHandler | undefined,
    attempt = 1
  ): Promise<{ imgCacheKey: string; imgCode?: string }> {
    const data = await this.#fetchGenerateCaptcha(identifier);

    if (data.status === "Success" && !data.requireInteraction && data.token) {
      return { imgCacheKey: data.token };
    }

    if (
      data.status === "Success" &&
      data.requireInteraction &&
      data.token &&
      data.captcha &&
      onCaptchaChallenge !== undefined
    ) {
      const parsedImage = parseCaptchaImagePayload(data.captcha);
      const challenge: CaptchaChallenge = {
        token: data.token,
        imageBytes: parsedImage.imageBytes,
        mimeExtension: parsedImage.mimeExtension,
      };

      const enteredCode = await onCaptchaChallenge(challenge);
      if (enteredCode === null) {
        throw new WeApiError({
          message: "CAPTCHA entry cancelled by user.",
          kind: "CAPTCHA_REQUIRED",
          endpoint: this.#captchaUrl,
        });
      }

      const trimmedCode = enteredCode.trim();
      if (trimmedCode.length === 0) {
        if (attempt >= MAX_CAPTCHA_ATTEMPTS) {
          throw new WeApiError({
            message: `Reached maximum CAPTCHA refresh attempts (${MAX_CAPTCHA_ATTEMPTS}).`,
            kind: "CAPTCHA_REQUIRED",
            endpoint: this.#captchaUrl,
          });
        }
        return this.#resolvePreAuthToken(
          identifier,
          onCaptchaChallenge,
          attempt + 1
        );
      }

      return {
        imgCacheKey: data.token,
        imgCode: trimmedCode,
      };
    }

    throw new WeApiError({
      message: `Interactive CAPTCHA or block triggered by WE (${data.status}, requireInteraction=${String(data.requireInteraction)}). Automated execution stopped.`,
      kind: "CAPTCHA_REQUIRED",
      endpoint: this.#captchaUrl,
    });
  }

  async #fetchGenerateCaptcha(
    identifier: string
  ): Promise<GenerateCaptchaResponse> {
    const response = await fetch(this.#captchaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        Origin: ECHANNEL_ORIGIN,
        Referer: `${ECHANNEL_ORIGIN}/`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        merchantName: this.#captchaMerchant,
        serviceName: "Login",
        identifier,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Pre-auth token endpoint ${this.#captchaUrl} failed with HTTP ${response.status}`
      );
    }

    return (await response.json()) as GenerateCaptchaResponse;
  }

  async #postBes<TReq, TRes>(endpoint: string, payload: TReq): Promise<TRes> {
    const requestHeaders: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: ECHANNEL_ORIGIN,
      Referer: ECHANNEL_ENTRY_URL,
      "User-Agent": USER_AGENT,
      channelId: DEFAULT_CHANNEL_ID,
      csrftoken: this.#csrfToken,
      isCoporate: "false",
      isMobile: "false",
      isSelfcare: "true",
      languageCode: DEFAULT_LOCALE,
    };

    const cookieHeader = this.#formatCookieHeader();
    if (cookieHeader.length > 0) {
      requestHeaders.Cookie = cookieHeader;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: requestHeaders,
      body: payload === undefined ? "" : JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    this.#captureCookies(response);

    if (!response.ok) {
      throw new Error(
        `WE API ${endpoint} failed with HTTP ${response.status} ${response.statusText}`
      );
    }

    const parsed = (await response.json()) as ApiResponse<TRes>;
    if (parsed.header?.retCode !== "0") {
      const errorOptions: {
        message: string;
        kind: "API_ERROR";
        endpoint: string;
        retCode: string;
        errorNo?: string;
      } = {
        message:
          `WE API ${endpoint} returned retCode=${parsed.header?.retCode ?? "unknown"} errorNo=${parsed.header?.errorNo ?? "none"} ${parsed.header?.errorMsg ?? ""}`.trim(),
        kind: "API_ERROR",
        endpoint,
        retCode: parsed.header?.retCode ?? "unknown",
      };
      if (parsed.header?.errorNo !== undefined) {
        errorOptions.errorNo = parsed.header.errorNo;
      }
      throw new WeApiError(errorOptions);
    }

    return parsed.body as TRes;
  }

  #captureCookies(response: Response): void {
    const setCookies = response.headers.getSetCookie();
    for (const raw of setCookies) {
      const parsed = parseSetCookiePair(raw);
      if (parsed) {
        this.#cookies.set(parsed.name, parsed.value);
      }
    }
  }

  #formatCookieHeader(): string {
    const parts: string[] = [];
    for (const [name, value] of this.#cookies) {
      parts.push(`${name}=${value}`);
    }
    return parts.join("; ");
  }
}

export async function fetchHomeUsage(
  credentials: WeClientCredentials,
  options?: FetchHomeUsageOptions
): Promise<FetchUsageResult> {
  const client = new WeApiClient();
  await client.bootstrap();
  const session = await client.authenticate(
    credentials,
    options?.onCaptchaChallenge
  );

  try {
    let mainOfferId: string | undefined;
    try {
      mainOfferId = await client.getMainOfferId(session);
    } catch {
      mainOfferId = undefined;
    }

    const snapshots = await client.queryFreeUnit(session, mainOfferId);
    return { session, snapshots };
  } finally {
    try {
      await client.logout();
    } catch {
      // Best-effort session cleanup should not mask a successful fetch or primary error.
    }
  }
}
