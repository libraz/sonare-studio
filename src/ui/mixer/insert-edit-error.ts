/**
 * User-facing text for a failed insert or mastering parameter edit. An edit
 * the engine refuses with its coupled keys reads as which keys block it; any
 * other error keeps its own message.
 */
import { errorMessage } from '@/lib/errors';
import {
  humanizeProcessorControlName,
  InsertConfigurationRefusedError,
} from '@/project/processor-controls';
import { formatMessage, type Messages } from '@/ui/i18n';

/** Names the coupled keys that block a refused edit, else the error's own message. */
export function insertEditErrorMessage(error: unknown, messages: Messages): string {
  if (error instanceof InsertConfigurationRefusedError) {
    return formatMessage(messages.reasons.coupledValue, {
      name: humanizeProcessorControlName(error.param),
      related: coupledKeyList(error.related),
    });
  }
  return errorMessage(error);
}

/** Human-readable list of coupled keys, for a tooltip or a refusal. */
export function coupledKeyList(keys: ReadonlyArray<string>): string {
  return keys.map(humanizeProcessorControlName).join(', ');
}
