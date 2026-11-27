export interface FreeUnitDetail {
  initialAmount: number;
  currentAmount: number;
  measureUnit: string;
  effectiveTime: number;
  expireTime: number;
  expireTimeCz?: number;
  originType: string;
  offeringName: string;
  isGroup: boolean;
  serviceNumber: string;
  itemCode: string;
  remainingDaysForRenewal?: number;
}

export interface ApiResponseHeader {
  retCode: string;
  errorNo?: string;
  errorMsg?: string;
  validateResults?: unknown[];
}

export interface ApiResponse<TBody> {
  header: ApiResponseHeader;
  body?: TBody;
}

export interface SysParamItem {
  key: string;
  value?: string;
}

export interface QuerySysParamsBody {
  paramsList: SysParamItem[];
}

export interface GenerateCaptchaResponse {
  status: string;
  token: string | null;
  requireInteraction: boolean;
  captcha: string | null;
}

export interface CaptchaChallenge {
  token: string;
  imageBytes: Uint8Array;
  mimeExtension: string;
}

export type CaptchaChallengeHandler = (
  challenge: CaptchaChallenge
) => Promise<string | null>;

export interface AuthenticateResponseBody {
  utoken?: string;
  uToken?: string;
  loginId: string;
  loginType?: string;
  token: string;
  needChangePwd?: string;
  account?: {
    acctId: string;
    acctCode?: string;
  };
  subscriber?: {
    subscriberId: string;
    servNumber: string;
    primaryOfferingId?: string;
  };
}

export interface SubscribedOfferingItem {
  offerId: string;
  offerEnName?: string;
  main?: boolean;
  mainOfferingId?: string;
  remainingDaysForRenewal?: number;
  renewalDate?: number;
}

export interface SubscribedOfferingsBody {
  offeringList?: SubscribedOfferingItem[];
}

export interface FreeUnitItem {
  tabId?: string;
  freeUnitType: string;
  freeUnitTypeName?: string;
  tabName?: string;
  measureUnit: string;
  offerName: string;
  total: number;
  used: number;
  remain: number;
  actualRemain: number;
  effectiveTime?: number;
  expireTime?: number;
  freeUnitTypeId: string;
  originUnit?: string;
  freeUnitBeanDetailList?: FreeUnitDetail[];
}

export interface WeAuthSession {
  token: string;
  subscriberId: string;
  serviceNumber: string;
  accountId: string;
}

export interface QuotaSnapshot {
  serviceNumber: string;
  subscriberId: string;
  offerName: string;
  freeUnitType: string;
  freeUnitTypeId: string;
  measureUnit: string;
  totalGb: number;
  usedGb: number;
  remainingGb: number;
  actualRemainingGb: number;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  remainingDaysForRenewal: number | null;
  rawDetails: FreeUnitDetail[];
}

export interface FetchUsageResult {
  session: WeAuthSession;
  snapshots: QuotaSnapshot[];
}
