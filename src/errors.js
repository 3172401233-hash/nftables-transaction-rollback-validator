export class TransactionValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TransactionValidationError';
    this.code = code;
    this.details = details;
    this.retryable = details.retryable ?? false;
    if (details.commandIndex !== undefined) this.commandIndex = details.commandIndex;
    if (details.commandId !== undefined) this.commandId = details.commandId;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      commandIndex: this.commandIndex,
      commandId: this.commandId,
      details: this.details,
    };
  }
}

export class CommitInterruptedError extends TransactionValidationError {
  constructor(message, details = {}) {
    super('COMMIT_INTERRUPTED', message, { retryable: details.outcome === 'aborted', ...details });
    this.name = 'CommitInterruptedError';
  }
}

export function fail(code, message, details = {}) {
  throw new TransactionValidationError(code, message, details);
}
