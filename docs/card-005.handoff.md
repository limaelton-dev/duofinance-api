# CARD-005 — contrato de entrada para o CARD-006

> **Estado atualizado em 10/10/2026:** CARD-005 integrado na API [PR #6](https://github.com/limaelton-dev/prospera_mais_api/pull/6), merge `28da1bb5956dc174cb0173af31bffcba33893517`, e na Web [PR #5](https://github.com/limaelton-dev/prospera-mais-web/pull/5), merge `c99d7b9ef6047efbfa8041b94fb42696595fe74b`. CI dos HEADs finais [API `242edba`](https://github.com/limaelton-dev/prospera_mais_api/actions/runs/38070324414) e [Web `d633429`](https://github.com/limaelton-dev/prospera-mais-web/actions/runs/38070787596) concluída com sucesso. A integração API antecedeu a Web. Os gates remotos anteriormente pendentes estão comprovados; a fundação da Wave 0 está disponível para o CARD-006/Wave 1. Os textos abaixo sobre manter commits locais/integração pendente preservam o estado da execução anterior e foram supersedidos por estes fatos posteriores. Esta preparação apenas verificou os merges, sem realizar nova integração, executar testes ou atualizar Trello/deploy. [Contexto atual](C:/Projs/ProsperaMais/Docs/Acompanhamentos/CONTEXTO-E-DECISOES.md).

---


Execução: 10/10/2026. ConfigureDefaultSettlementRule / UC-FIN-040, último card da Wave 0. Consumo em despesa, compromisso, pendência ou ciclo real pertence à Wave 1; não foi antecipado neste card.

- [Refinamento e critérios](https://drive.google.com/file/d/1E4WlCITOI5hxsYnhC7LU8rVdAk_N0ChR/view).
- [Acompanhamento, exatamente duas etapas](https://drive.google.com/file/d/1lreBTeuer_vPRItA4cYPGnDZ5GxilpUl/view).
- [Fases e evidências A01–A20](https://drive.google.com/file/d/1qwUWshBQ_yvX8GwNcl6lC5YB6VZg-AvH/view).
- [Roteiro pela interface](https://drive.google.com/file/d/1DAeWFeRT7Sp14mMfUev4HXKbucPQsFJy/view).

## Domínio e consumo futuro

`src/modules/finances` possui domain/application/infrastructure/http próprios. `DefaultSettlementRule` é agregado de Finanças identificado por `spaceId`; `Space` não recebeu campo financeiro. `SettlementRule` é VO imutável com snapshot por valor `{ kind: 'MONTHLY_DAY', dayOfMonth: 1..31 }`. Essa representação mensal não é uma frequência de recorrência de compromisso.

Compartilhado começa sem regra; ausência é `rule: null`, `version: 0`, `updatedAt: null`. GET não cria configuração. Primeira configuração produz v1; alteração real incrementa versão e registra antes/depois/ator/instante. Mesmo dia com versão atual é no-op: conserva versão/histórico e pode gravar recibo. Versão obsoleta conflita mesmo se o dia enviado coincidir com o atual.

`SettlementRule.suggestTargetDate(referenceDate)` recebe data civil válida `YYYY-MM-DD` e retorna a primeira ocorrência ajustada maior ou igual à referência. O candidato mensal é o menor entre o dia configurado e o último dia do mês. Se já passou, recalcula no mês seguinte; fevereiro, bissexto e virada de ano são tratados sem conversão UTC nem overflow de Date. Dia 10 em 2026-09-10 sugere a mesma data; em 2026-09-11 sugere 2026-10-10. Dia 31 em 2026-02-28 sugere 2026-02-28.

O CARD-006 fornecerá a referência conforme seu próprio caso de uso e incorporará snapshot da regra aplicável ao compromisso. Data do fato, registro e acerto continuam independentes; a configuração não escolhe essa equivalência. Ausência não deve inventar um dia, obrigar configuração ou criar ciclo. Alterar o padrão não modifica snapshots/datas/ciclos de fatos existentes. O repository deste card escreve exclusivamente configuração, alterações e recibos. Não existe vínculo mutável entre padrão e futuro snapshot do compromisso.

## Autorização e transação

Finances importa `SpacesModule` e consome somente `SPACE_ACCESS_PORT` na aplicação; não consulta tabelas/repositories/agregado privado de Spaces. Ator vem da sessão, destino é explícito. Qualquer membro ativo de SHARED pode configurar, inclusive criador sozinho; papel de emissor do convite não é requisito financeiro.

Leitura chama `assertCanRead`, exige SHARED e reautoriza depois de carregar a configuração. Pessoal próprio recebe `SHARED_SPACE_REQUIRED`; terceiro/inexistente/participação revogada recebem o mesmo `SPACE_NOT_FOUND`. SHARED CLOSING/CLOSED acessível continua legível.

Comando usa a UnitOfWork existente. Autoriza leitura/tipo e procura recibo antes de verificar nova escrita. Sem recibo, `assertCanWrite` exige ACTIVE, mesmo para novo no-op; acesso/estado são revalidados antes da persistência. A mesma infraestrutura EntityManagerProvider observa a transação. Essa revalidação não promete coordenação atômica com comandos futuros de encerramento: sua solução pertence ao card de lifecycle.

CAS usa INSERT inicial protegido por PK e UPDATE com space_id/version esperada, exigindo exatamente uma linha. Duas chaves diferentes disputando a mesma versão produzem um sucesso e um conflito. Estado, alteração histórica e recibo fazem commit/rollback juntos. Datas de alteração são instantes TIMESTAMPTZ/ISO UTC; datas de acerto são civis, com timezone de negócio America/Sao_Paulo.

## Recibos e recuperação

Recibo privado de Finances é identificado por ator/operação/chave, com operação `CONFIGURE_DEFAULT_SETTLEMENT_RULE`. Hash SHA-256 canônico inclui operação, destino, versão esperada, kind e dia normalizados. Mesma chave/entrada recupera resultado original; payload diferente, inclusive outro destino, retorna `IDEMPOTENCY_KEY_REUSED`. Outro ator não herda o recibo.

Replay exige acesso de leitura atual e SHARED antes de expor resultado. Pode recuperar tentativa concluída em CLOSING/CLOSED acessível; isso não permite uma nova escrita nesse estado. Referência histórica por `(spaceId, version)` recupera dia/instante originais e `changed`, com `replayed: true`. Uma alteração posterior permanece intacta. Após PUT/replay, reconsultar GET; resultado histórico não é a regra atual.

Violação conhecida de PK/CAS recupera o recibo em nova UnitOfWork depois do rollback, reautorizando e validando hash. Sem recibo correspondente, preserva o conflito. No-op concorrente da mesma chave também tem apenas um recibo funcional. SQL não é exposto como erro público.

## REST/OpenAPI

- `GET /v2/spaces/:spaceId/default-settlement-rule`: `{ spaceId, rule, version, updatedAt }`; 200 com ausência ou configuração autorizada.
- `PUT` na mesma rota: body `{ expectedVersion, rule: { kind: 'MONTHLY_DAY', dayOfMonth } }`; 200 acrescenta `changed` e `replayed`.

PUT exige sessão, `X-CSRF-Token` e `Idempotency-Key` UUID. DTOs rejeitam campos desconhecidos, rule null, kind desconhecido, dia/string/fração fora do contrato e versão não inteira segura >=0. Erros de campo usam pt-BR; campos aninhados aparecem como `rule.dayOfMonth` em `details.fields`.

Erros mantêm `{ code, message, details }`: 400 VALIDATION_ERROR; 401 UNAUTHENTICATED; 403 INVALID_CSRF_TOKEN; 404 SPACE_NOT_FOUND; 409 SHARED_SPACE_REQUIRED/SPACE_NOT_ACTIVE/CONCURRENT_MODIFICATION/IDEMPOTENCY_KEY_REUSED; 429 TOO_MANY_REQUESTS com Retry-After; falhas internas 5xx. Cache-Control é no-store. OpenAPI 3.1 documenta exemplos de ausência/configuração, headers e respostas. Auth/Spaces/Invitations mantêm contrato; a versão informativa do documento passou para 0.4.0.

Sem DELETE, preview de ciclo, preferência UI no servidor ou campos novos em Auth/Spaces.

## Persistência e ambiente

Migration aditiva `1791590400000-ConfigureDefaultSettlementRule.ts`, com synchronize false:

- `default_settlement_rules`: PK space_id, tipo/dia/version e timestamps; FK por ID a spaces com RESTRICT.
- `default_settlement_rule_changes`: PK space_id/version, ator, antes/depois e instante; histórico append-only pelo repository.
- `finances_command_receipts`: PK ator/operação/key, hash/status, referência histórica/version, changed e instante.

Checks validam dia 1–31, tipo fechado, versões positivas, par anterior consistente e hash SHA-256 de 32 bytes. Down remove somente os objetos deste card na ordem inversa. Up/down/up, constraints e preservação de dados Auth/Spaces foram testados em PostgreSQL descartável 55432. Nenhum banco de desenvolvimento foi alterado. Antes do teste manual, aplicar as migrations no banco escolhido pelo fluxo normal; rollback destrutivo de dados exige decisão operacional própria.

## Web, evidências e integração

`src/features/finances` tem tipos/cliente/query/comando próprios, separados de SpaceWrite e do fluxo de convite. A rota `/spaces/[spaceId]/settings` é aberta por Configurações do espaço no detalhe SHARED. A seção Regras financeiras distingue ausência, leitura, erro/retry, formulário, envio incerto, conflito e sucesso; dias 29–31 usam explicação do último dia válido. O pessoal não oferece configuração; CLOSING/CLOSED mantém leitura e bloqueia edição.

Key de leitura: `['finances', personId, spaceId, 'default-settlement-rule']`. Mudança confirmada de sessão/pessoa, logout/401, troca de espaço e perda de acesso cancelam/removem as queries financeiras pertinentes. Época de sessão e geração do contexto impedem resposta antiga em A→B→A e logout/login da mesma pessoa. Somente UUID de preferência permanece no sessionStorage; regra, rascunho e tentativa são voláteis.

Edição captura pessoa/espaço/época/geração na abertura e versão da leitura. Troca anterior ao envio descarta o rascunho com aviso; envio/resultado incerto bloqueia seletor e navegação interna. Retry é explícito e conserva destino/entrada/versão/chave, inclusive após CSRF/429/rede/5xx. Abort não comprova rollback do servidor. Após conflito, GET atual preserva rascunho e a ação Confirmar nova tentativa gera chave nova com versão atual. Após sucesso/replay, GET da regra atual confirma o resumo; PUT histórico não é inserido no cache como estado atual.

O shell e o seletor reconhecem settings. Trocar SHARED conserva essa rota no destino validado; pessoal vai ao detalhe. `accessFallback` explícito no contexto permite navegar para o pessoal depois de revogação, sobrevivendo à desmontagem do formulário e preservando navegação voluntária mais recente.

API implementada em `69c0c04689a548b6ceb74269f219f48db11fab1e`; 297 unitários (62 novos) e 178 HTTP/PostgreSQL (18 novos cenários), lint/formatação/tipos/build/diff e revisão independente aprovados. Web implementada em `d63342931ac1e4d50bc672a2c1bc48d3d357770d`; lint/formatação/tipos/build/diff e revisão independente aprovados sobre o código final.

Playwright aprovou 76 testes em lotes separados para respeitar limites de autenticação: 20 do CARD-005/clientes financeiros (17 jornadas + 3 testes de dados), 22 do CARD-001/002/clientes, 11 do CARD-003 e 23 do CARD-004/contexto. São 20 novos e 56 regressões, sem somar tentativas intermediárias. A cobertura inclui duas pessoas, criador sozinho, ausência, alteração, validação/cancelamento, desktop/mobile/teclado, leitura CLOSING/CLOSED, revogação real, isolamento A→B→A, logout/login da mesma pessoa, replay seguido de GET atual, falhas CSRF/429/rede/5xx, lock/retry explícito e conflito com nova confirmação.

Revisão visual local aprovada em 10/10/2026 sobre os artefatos finais, com conta sintética e compartilhado de teste, API/Web nas portas 3101/3100 e PostgreSQL descartável 55432. Conferidos link com acentos, ausência, dia 0 com erro e foco, gravação de 31, persistência após refresh e cancelamento de edição sem alteração. Desktop e formulário mobile 390×844 permaneceram legíveis e sem rolagem horizontal. Evidências visuais locais sem convites/segredos: `C:/Projs/ProsperaMais/Docs/Acompanhamentos/Wave-0-Fundacao/CARD-005/Evidencias/CARD-005-INTERFACE.jpg` e `C:/Projs/ProsperaMais/Docs/Acompanhamentos/Wave-0-Fundacao/CARD-005/Evidencias/CARD-005-INTERFACE-MOBILE.jpg`.

As evidências e o estado da publicação estão no acompanhamento. A01–A19 estão aprovados no escopo atual; A20 tem jornada/regressões/revisão/handoff local aprovados. PRs, CI nos HEADs finais, SHAs de integração e sincronização de main não foram executados: Elton escolheu manter somente os commits locais em 10/10/2026. A entrega local está concluída; a Wave 0 ainda não está encerrada tecnicamente no remoto.

O envio ao GitHub foi inicialmente rejeitado pela aprovação automática por não encontrar autorização específica para transmitir código potencialmente privado. Depois da implementação, dos testes e dos registros concretos, Elton respondeu à confirmação: **Manter somente os commits locais**. Essa decisão encerra esta execução no escopo local; nenhuma publicação, PR ou merge foi realizado. Para uma futura integração, publicar as branches do CARD-005, abrir PRs contra main, exigir CI nos HEADs finais e integrar API antes da Web. Trello permanece sob atualização manual de Elton.
