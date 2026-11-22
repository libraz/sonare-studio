/** Errors raised by the OPFS audio asset store. */

/** Thrown when no stored asset matches the requested id. */
export class AssetNotFoundError extends Error {
  constructor(id: string) {
    super(`No stored audio asset with id "${id}"`);
    this.name = 'AssetNotFoundError';
  }
}

/** Thrown when asset inputs or stored asset files are malformed. */
export class InvalidAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAssetError';
  }
}
