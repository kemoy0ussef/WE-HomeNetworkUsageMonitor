export type WeErrorKind = "API_ERROR" | "CAPTCHA_REQUIRED";

export class WeApiError extends Error {
  readonly kind: WeErrorKind;
  readonly endpoint: string;
  readonly retCode: string | undefined;
  readonly errorNo: string | undefined;

  constructor(options: {
    message: string;
    kind: WeErrorKind;
    endpoint: string;
    retCode?: string;
    errorNo?: string;
  }) {
    super(options.message);
    this.name = "WeApiError";
    this.kind = options.kind;
    this.endpoint = options.endpoint;
    this.retCode = options.retCode;
    this.errorNo = options.errorNo;
  }
}
