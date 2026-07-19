let generation = 0;

export function getApiMutationGeneration(): number {
  return generation;
}

export function recordApiMutation(): void {
  generation += 1;
}
