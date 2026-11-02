import { DOCUMENT, Service, inject, isDevMode } from '@angular/core';

const SCENARIOS = [
  'sem-conexao',
  'pendentes',
  'nao-enviada',
  'sem-conversas',
  'carregando',
  'reconectado',
  'erro-historico',
  'erro-pesquisa',
  'entrar-falha',
  'sem-resposta',
  'erro-acao',
] as const;

export type Scenario = (typeof SCENARIOS)[number];

function isScenario(name: string): name is Scenario {
  return (SCENARIOS as readonly string[]).includes(name);
}

/**
 * States the fixed data can't reach through actions, chosen with `?cenario=a,b` in development.
 * They are read once, when the page opens, so in-app navigation doesn't drop them.
 */
@Service()
export class Scenarios {
  private readonly document = inject(DOCUMENT);

  private readonly active: ReadonlySet<Scenario> = isDevMode()
    ? parseScenarios(this.document.location.search)
    : new Set();

  public has(scenario: Scenario): boolean {
    return this.active.has(scenario);
  }

  public any(): boolean {
    return this.active.size > 0;
  }
}

function parseScenarios(search: string): Set<Scenario> {
  const names = new URLSearchParams(search).get('cenario')?.split(',') ?? [];
  const scenarios = new Set<Scenario>();
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    if (isScenario(name)) {
      scenarios.add(name);
    } else {
      console.warn(`Unknown scenario "${name}". Known: ${SCENARIOS.join(', ')}.`);
    }
  }
  return scenarios;
}
