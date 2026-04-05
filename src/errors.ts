export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'api_error',
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toJSON() {
    return {
      error: {
        type: this.code,
        message: this.message,
      },
    };
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string) {
    super(400, message, 'invalid_request_error');
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Invalid or missing API key') {
    super(401, message, 'authentication_error');
  }
}

export class TooManyRequestsError extends ApiError {
  constructor(message = 'Too many concurrent requests') {
    super(429, message, 'rate_limit_error');
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(404, message, 'not_found_error');
  }
}

export class GatewayTimeoutError extends ApiError {
  constructor(message = 'Claude process timed out') {
    super(504, message, 'timeout_error');
  }
}

export class InternalError extends ApiError {
  constructor(message = 'Internal server error') {
    super(500, message, 'api_error');
  }
}
