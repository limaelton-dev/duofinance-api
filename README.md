# DuoFinance API

API NestJS com PostgreSQL, contratos REST em `/v2`, sessões por cookie e proteção CSRF. As regras de produto e decisões ficam na [documentação oficial](../Docs/README.md); o [contexto atual](../Docs/Acompanhamentos/CONTEXTO-E-DECISOES.md) aponta para as evidências de entrega.

Repositórios: [API](https://github.com/limaelton-dev/duofinance-api) e [Web](https://github.com/limaelton-dev/duofinance-web).

## Renomeação para DuoFinance

Em 20/10/2026, o projeto passou a se chamar **DuoFinance**. O pacote é `duofinance-api` e a documentação OpenAPI usa a nova marca. Os contratos `/v2`, cookies, variáveis de ambiente e dados existentes continuam compatíveis; a renomeação não exige migration nem alteração do banco configurado em `DATABASE_URL`.

O ambiente descartável de testes usa o projeto Compose `duofinance-tests` e o banco `duofinance_test`. Caso o projeto de testes anterior ainda esteja usando a porta 55432, encerre-o antes de iniciar o novo:

```sh
docker compose -p prospera-mais-tests -f compose.test.yaml down
docker compose -f compose.test.yaml up -d --wait
```

O banco de testes usa `tmpfs`: encerrar esse ambiente descarta seus dados. Esse procedimento não se aplica ao banco de desenvolvimento ou produção.

## Desenvolvimento local

Use Node na versão de `.nvmrc` e PostgreSQL 18. Instale as dependências com `npm ci`, copie `.env.example` para `.env` e configure `DATABASE_URL`, `WEB_ORIGIN` e um `CSRF_SECRET` aleatório com pelo menos 32 caracteres.

```sh
npm run migration:run:dev
npm run start:dev
```

O banco de desenvolvimento precisa existir. `compose.test.yaml` cria somente o banco descartável de testes na porta 55432. A aplicação não sincroniza nem migra o banco automaticamente.

## Testes por comportamento

Os nomes descrevem capacidades atuais: `shared-cash-expenses`, `income-receipts`, `settlement-transfers`, `task-completion` e `closure-conclusion`. IDs de cards e waves pertencem ao histórico de entrega, não à identidade dos testes.

Descrições de suítes e cenários, rótulos de casos parametrizados e mensagens técnicas dos testes são escritos em inglês. Mensagens e dados em português permanecem quando representam o contrato ou o conteúdo do produto que o teste verifica.

- `src/**/*.spec.ts`: invariantes de domínio e decisões de aplicação com fakes, sem banco.
- `test/**/*.e2e-spec.ts`: contratos HTTP e integração com PostgreSQL. Apesar do sufixo existente, não executam navegador.
- `test/*-persistence.e2e-spec.ts`: constraints, consultas, locks e transações cuja proteção depende do banco real.
- `test/database-schema.e2e-spec.ts`: criação e reversão da estrutura vazia, consistência com entidades e objetos SQL complementares.

Manter um cenário em mais de uma camada só faz sentido quando protege falhas diferentes. Por exemplo, calcular centavos no domínio, impedir gravação parcial no PostgreSQL e aplicar autorização pelo HTTP são responsabilidades distintas. Não repetir toda a matriz de regras pelos três caminhos. Para uma feature ou correção, escolher a camada mais baixa que reproduz a falha e acrescentar integração quando houver risco no contrato, na autorização ou na persistência.

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
docker compose -f compose.test.yaml up -d --wait
npm run test:e2e
docker compose -f compose.test.yaml down
```

Para executar uma jornada, passe o nome do arquivo, por exemplo: `npm run test:e2e -- test/settlement-transfers.e2e-spec.ts`. As suítes de integração recriam ou limpam o mesmo banco; execute-as sequencialmente. O CI divide os arquivos em dois grupos, cada um com seu próprio PostgreSQL.

## Baseline do banco e próximas migrations

Em 20/10/2026, o histórico anterior ao primeiro deploy foi consolidado porque todos os dados eram de teste. Um banco novo recebe a estrutura atual diretamente. Bancos que aplicaram o histórico antigo precisam ser recriados antes de adotar esta baseline.

Para um banco local descartável já existente, confira primeiro o destino de `DATABASE_URL`, pare a API e execute:

```sh
npm run typeorm -- schema:drop -d src/shared/technical/database/typeorm/data-source.ts
npm run migration:run:dev
```

O primeiro comando apaga a estrutura e os dados do banco configurado. Ele é uma etapa de transição da baseline e não faz parte do deploy. Reverter a baseline também remove toda a estrutura: seu teste de reversão usa banco vazio. Depois que houver dados a preservar, rollback de código não deve executar automaticamente o rollback de schema.

Após a baseline, cada alteração cria uma nova migration incremental. Não editar migrations já aplicadas em ambientes com dados a preservar:

```sh
npm run migration:generate -- src/shared/technical/database/typeorm/migrations/DescribeBusinessChange -d src/shared/technical/database/typeorm/data-source.ts
npm run migration:run:dev
npm run typeorm -- schema:log -d src/shared/technical/database/typeorm/data-source.ts
```

Revise o SQL gerado. Algumas tabelas financeiras e índices são mantidos explicitamente por SQL e não são totalmente representados pelas entidades; ausência de diferenças em `schema:log` não substitui a verificação desses objetos. Testes funcionais aplicam as migrations disponíveis, sem importar versões históricas ou enumerar seus nomes. Uma migration futura que transforma dados deve receber teste específico de atualização com dados representativos.

## CI e deploy

`API checks` exige a aprovação de `API quality` e dos dois grupos PostgreSQL/HTTP. A proteção de `main` depende desse gate. O workflow executa em PRs para `main`, push em `main` e acionamento manual; não repete push e PR da mesma branch de trabalho.

Em implantação, executar `npm ci`, `npm run build`, `npm run migration:run` e iniciar com `npm run start:prod`. O processo de deploy deve aguardar o CI e interromper se a migration falhar. Configure as variáveis de ambiente no destino; credenciais locais e o banco descartável de testes não fazem parte da implantação.
