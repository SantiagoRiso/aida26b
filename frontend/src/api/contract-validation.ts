import type { ListMeta } from '@shared/ssot/envelope';
import type { Decoder } from '@/api/decoders';
import type { ApiResult } from '@/api/result';

export type ApiContractFailure = { path: string; status: number; diagnostic: string };
type ContractFailureReporter = (failure: ApiContractFailure) => void;

let contractFailureReporter: ContractFailureReporter = (failure) => {
  if (import.meta.env.PROD) console.error('api_contract_failure', failure);
};

export function setApiContractFailureReporter(reporter: ContractFailureReporter): () => void {
  const previous = contractFailureReporter;
  contractFailureReporter = reporter;
  return () => { contractFailureReporter = previous; };
}

function defaultSuccessStatuses(method: string): readonly number[] {
  if (method === 'POST') return [200, 201, 204];
  if (method === 'PUT' || method === 'PATCH') return [200, 202];
  if (method === 'DELETE') return [200, 204];
  return [200];
}

export function validateResponseContract<T>(input: {
  decoder: Decoder<T>;
  path: string;
  method: string;
  status: number;
  // eslint-disable-next-line no-restricted-syntax -- Endpoint decoder owns narrowing the untrusted payload.
  data: unknown;
  meta?: ListMeta;
  successStatuses?: readonly number[];
}): ApiResult<T> {
  const successStatuses = input.successStatuses ?? defaultSuccessStatuses(input.method);
  if (!successStatuses.includes(input.status)) {
    const diagnostic = `$status: expected ${successStatuses.join(' or ')}, received ${input.status}`;
    contractFailureReporter({ path: input.path, status: input.status, diagnostic });
    return { ok: false, status: input.status, code: 'bad_response', message: 'Unexpected response status', diagnostic };
  }
  if (!input.decoder(input.data)) {
    const diagnostic = input.decoder.explain(input.data) ?? '$: payload contract rejected the value';
    contractFailureReporter({ path: input.path, status: input.status, diagnostic });
    return { ok: false, status: input.status, code: 'bad_response', message: 'Unexpected response payload', diagnostic };
  }
  return { ok: true, data: input.data, meta: input.meta };
}
