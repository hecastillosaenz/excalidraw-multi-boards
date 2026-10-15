/** An error that maps 1:1 to an HTTP response `{ error, message }`. */
export class ApiError extends Error {
  status: number;
  code: string;

  // No parameter properties: Node's type stripping only supports erasable syntax.
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
