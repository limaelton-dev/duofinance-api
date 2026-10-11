# CARD-006 — contrato de entrada para o CARD-007

Execução local iniciada em 10/10/2026, retomada em 11/10/2026. RecordSharedCashExpense / Wave 1. Documento de implementação; refinamento, acompanhamento, evidências e roteiro de interface permanecem na documentação oficial em `Docs/Acompanhamentos/Wave-1-Walking-Skeleton-Financeiro/CARD-006`.

## Recorte entregue

Despesa EXPENSE/ONE_TIME de SHARED ACTIVE, quitada integralmente por um único desembolso PIX, DEBIT ou CASH. Responsabilidade econômica e responsável previsto são independentes do pagador efetivo. Um ou dois membros ativos; criador sozinho não produz dívida nem ciclo artificial.

Não há receita, despesa pessoal, cartão, parcelamento, recorrência, pagamento parcial, edição, transferência, compensação, dispensa ou finalização de acerto. O 007 deverá ler pendências já reconciliadas, sem criar/reparar fatos em GET. Posição, acerto e Hoje continuam nos respectivos cards da wave.

## Domínio, valores e datas

Finances conserva domain/application/infrastructure/http próprios. FinancialCommitment contém a versão inicial, a divisão econômica e o Disbursement; InterMemberObligation e SettlementCycle possuem repositories próprios. A reconciliação pura calcula a parte do não pagador e cria pendência somente quando positiva. O histórico CREATED é gravado junto da pendência inicial.

Money utiliza centavos inteiros seguros de 1 até 9007199254740991 para o total; partes podem ser zero. BIGINT no PostgreSQL e transformer validado mantêm a precisão e preservam null. AMOUNTS exige soma exata; PERCENTAGES exige 10000 basis points. BigInt, maior resto e desempate por UUID normalizado em ordem lexical distribuem todo centavo. Persistem entrada original e partes calculadas; não recomputar a interpretação histórica com uma nova regra.

factDate é data civil válida passada/hoje; registeredAt é instante do servidor. targetDate é outro eixo, hoje/futuro para DATE, com OPEN vencido selecionável por ID. Referência de negócio usa America/Sao_Paulo. SUGGESTED exige referenceDate atual e expectedRuleVersion. A regra mensal do 005 é copiada por valor, ou null/version 0 quando ausente; alterações posteriores não modificam fatos existentes.

## Porta pública e protocolo transacional

Finances consome SPACE_FINANCIAL_CONTEXT_PORT; SQL e autorização de Spaces permanecem em Spaces. O contexto expõe versão, estado, ator e membros autorizados com IDs/nome. Leitura obtém autorização e membros consistentes. Nova escrita toma FOR SHARE da raiz Space na UnitOfWork, exige ACTIVE e versão esperada; aceite real de convite espera o lock da raiz.

Ordem: Space → Cycle → writes. Seleção DATE/SUGGESTED procura/cria o ciclo único `(spaceId, targetDate)`; CYCLE toma o OPEN existente no mesmo espaço. FINALIZED é recusado e permanece ocupando a data única. NONE não associa ciclo. Sem pendência, somente NONE é válido.

Compromisso/versão/partes/desembolso/pendência/histórico/ciclo/recibo fazem commit ou rollback juntos. Os oito pontos de escrita foram exercitados com falhas e contagem de todas as tabelas. Não existe persistência financeira no GET de opções ou detalhe.

## REST / OpenAPI 0.5

- `GET /v2/spaces/:spaceId/financial-entry-context`: contexto público de Spaces autorizado para o composer.
- `GET /v2/spaces/:spaceId/shared-cash-expense-options` com cursor opcional `?cursor=<cursor>`: contexto, referência, padrão/sugestão e até 20 ciclos OPEN, ordenados por data/ID. Cursor opaco vinculado ao espaço; valor vazio é inválido.
- `POST /v2/spaces/:spaceId/shared-cash-expenses`: entrada com expectedSpaceVersion, description, amountInCents, factDate, expectedPayerMemberId, responsibilitySplit, disbursement e settlement. Exige sessão, X-CSRF-Token e Idempotency-Key UUID. Responde 201 e Location também no replay.
- `GET /v2/spaces/:spaceId/financial-commitments/:commitmentId`: detalhe autorizado, membros públicos e estado atual da pendência/ciclo, sem replayed.

responsibilitySplit retorna mode/shares originais e calculatedShares. settlement é união fechada NONE, DATE/targetDate, CYCLE/cycleId ou SUGGESTED/referenceDate/expectedRuleVersion. O POST confirma fatos iniciais; GET lê o estado atual. Não inserir um resultado histórico de replay como substituto do estado atual.

DTOs recusam campos desconhecidos e variantes inválidas. Envelope estável `{ code, message, details }`, mensagens pt-BR, campos aninhados e no-store. EXPENSE_OPTIONS_CHANGED exige reconsulta e nova confirmação, inclusive para versão da regra ou referência da sugestão obsoleta; SETTLEMENT_CYCLE_FINALIZED exige outra escolha. SPACE_NOT_FOUND não revela acesso de terceiros. Personal recebe SHARED_SPACE_REQUIRED. CLOSING/CLOSED acessível admite leitura/replay, sem nova escrita.

## Recibo e recuperação

Recibo por ator/operação RECORD_SHARED_CASH_EXPENSE/chave; hash SHA-256 canônico de 32 bytes normaliza UUIDs/ordem das partes e captura a entrada funcional completa. Mesma chave/entrada recupera IDs e resultado inicial; entrada diferente retorna IDEMPOTENCY_KEY_REUSED. Outro ator não herda o recibo.

Replay exige autorização atual de leitura. Uma corrida de recibo recupera em nova UnitOfWork após rollback, reautoriza e confere hash; não reutiliza uma transação PostgreSQL abortada. Mesma chave concorrente gera uma origem; chaves distintas podem compartilhar o mesmo ciclo sem fundir compromissos.

## Migration e limites para o 007

Migration aditiva `1791655785713-RecordSharedCashExpense.ts`, gerada dos modelos ORM e revisada, com synchronize false. Drift sobre constraints do 005 foi removido.

Tabelas: financial_commitments, financial_commitment_versions, financial_commitment_shares, financial_disbursements, settlement_cycles, inter_member_obligations, inter_member_obligation_changes e financial_expense_command_receipts. FKs compostas impedem origem/membro/ciclo de outro espaço; checks distinguem variantes e null; uniques preservam origem e data do ciclo.

Os checks atuais de pendência/histórico cobrem somente OPEN/CREATED do 006. Cards que acrescentarem estados/operações deverão evoluir explicitamente domínio, histórico e constraints por migration própria. Não usar atualização direta de saldo/status como implementação de acerto. Os membros históricos são protegidos por FK RESTRICT; não apagá-los para simular revogação.

Somente PostgreSQL descartável 55432 foi utilizado. Up/down/up preservou Auth, Spaces e configuração 005. Nenhuma migration foi aplicada ao banco de desenvolvimento nesta execução. Aplicar migrations no ambiente escolhido pelo fluxo normal antes do teste manual.

## Web e isolamento

Rotas `/spaces/[spaceId]/expenses/new` e `/spaces/[spaceId]/expenses/[commitmentId]`, com entrada Adicionar despesa no compartilhado. Formulário WF-06, divisão exata, previsto/pagador independentes, acerto opcional, resumo vivo e confirmação do servidor. Falha parcial de opções conserva campos e usa contexto público/regra 005 como fallback; sem membros autorizados o envio fica bloqueado.

Queries financeiras incluem pessoa/espaço/cursor ou commitmentId. Época de sessão e geração do contexto impedem publicação de resposta antiga em A→B→A e logout/login da mesma pessoa. A captura é conferida no sucesso e na falha antes do tratamento de 401, inclusive no GET do padrão usado como fallback: erro antigo não encerra a geração atual. Rascunho e tentativa permanecem voláteis. Nenhum placeholder financeiro de outro espaço.

Comando captura cópia profunda da entrada, chave, ator e espaço. Rede/CSRF/429/5xx mantêm tentativa imutável e navegação/troca/logout bloqueados até retry explícito; renovar CSRF não reenvia POST automaticamente. Após conflito preserva rascunho, reconsulta e exige nova confirmação/chave. Abort não comprova rollback do servidor.

Saída de rascunho solicita confirmação. Histórico interno usa Navigation API quando disponível e listener global precoce com índices das entradas normais como fallback, sem sentinelas; restaura direção/distância quando a saída é recusada ou a tentativa está incerta. Reconsulta limpa páginas/cursor/seleção de ciclo para não conservar opção obsoleta. Refresh, fechamento de aba e travessia para outro documento dependem da confirmação nativa beforeunload do navegador; não oferecem persistência do rascunho/tentativa nem bloqueio absoluto de saída. Fallback em Chromium sem Navigation API não equivale a execução nativa em Safari/Firefox.

## Evidências e estado de execução

API commits: `867cca8` domínio; `61db749` persistência; `80610da83d4a43c2e68e377f852b9fb6165a47f4` jornada API. 323/323 unitários (297 anteriores + 12 domínio + 14 aplicação) e 223/223 HTTP/PG (178 anteriores + 28 HTTP + 17 persistência). Lint, format:check, typecheck, build, diff e revisão independente aprovados.

Web commit `bd871251d9feb256da4060617fbe5450f30d79c4`, concluído em 11/10/2026. 104 testes Playwright únicos aprovados: 76 anteriores, uma regressão nova de logout público do 003 e 27 novos do 006 (25 jornadas + dois testes de dados). Execução em lotes sem duplicação: 35 do 003/004/contexto e 20 do 005/dados em 10/10; 27 do 006/dados, um do 001 e 21 do 002/espaços/convites em 11/10. Lint, format:check, typecheck, build de produção do runner e diff aprovados; revisão estática sem achados pendentes. As duas falhas intermediárias eram preparação de CSRF e travessia para about:blank; provas corrigidas passaram, sem mudar o comportamento aprovado para satisfazer o teste.

As cinco etapas foram concluídas localmente. Validação manual do root em 11/10/2026, com contas sintéticas e banco descartável: Mercado R$ 500,00, A40/B60, B paga e A deve R$ 200,00; A paga e B deve R$ 300,00, selecionando o mesmo ciclo OPEN; segunda pessoa consulta o fato; 100% do pagador e criador sozinho sem obrigação/ciclo; espaço pessoal sem entrada; R$ 1,01 em 50/50 preserva R$ 0,50/R$ 0,51 e explica o residual. Regra dia15 permanece no detalhe depois de alterada para dia20, com refresh. Capturas desktop/mobile inspecionadas, sem overflow horizontal em viewport390; Tab da descrição alcança o valor. A saída/continuação do rascunho é comprovada pela suite Web; a tentativa manual de abrir a confirmação interrompeu o controle do navegador e não é contada como aprovação manual desse diálogo.

Matriz A01–A24, capturas sintéticas e roteiro repetível permanecem na pasta oficial CARD-006 do Drive. O CARD-007 pode partir deste contrato; a integração remota deve ser conferida antes de iniciar uma branch sobre main.

Limites das provas: perda de acesso após registro foi simulada pela porta pública; não existe lifecycle real de revogação neste card. Virada de dia utiliza relógio simulado. CSRF/429/5xx da Web usam interceptações controladas. Não há publicação, PR, CI remoto, integração ou deploy do 006 nesta execução local; Trello permanece sob atualização manual de Elton. A Wave 1 exige 006–010 e revisão da jornada completa.
