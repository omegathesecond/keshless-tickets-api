# Table fulfilment — build checklist

Spec: `docs/superpowers/specs/2026-09-06-table-fulfilment-design.md`

Worktrees:
- api → `api-tableflow-wt` (`feat/table-fulfilment`, off `dev`)
- pos-app → `pos-app-tableflow-wt` (`feat/table-fulfilment`, off `main`)
- dashboard → `dashboard-catalogue-wt` (`feat/catalogue-categories`, off `dev`)

Every box traces to a line in the original request. Nothing is done until its
test passes.

---

## Group 0 — The two bugs

- [x] **0.1** api: `requireWaiterPermission` re-reads `waiter.grants` from the
      row; fails closed on missing/deactivated. *(settling toggle did nothing)*
- [x] **0.2** api: `GET /api/waiter/events` returns live `permissions`
- [ ] **0.3** pos-app: `Session.canSettleTables` reads server permissions, not
      the JWT
- [ ] **0.4** pos-app: `splash_page.dart` routes a restored waiter session to
      `WaiterShell` *("sometimes when logged in as waiter it goes to the sell
      ticket screen (massive bug)")*

## Group 1 — Fulfilment lifecycle (api)

- [ ] **1.1** `Table.fulfilment[]` — model + interface + model tests
- [ ] **1.2** `addItem` creates the stall's row at `new`; `removeItem` drops it
      with the last line
- [ ] **1.3** `settle` flips every row `new → paid` inside the money
      transaction, under the `revision` guard *(request item 1: checkout)*
- [ ] **1.4** `TableService.handOut` — `paid → handed_out`, guarded
      *(item 2: bar/food person gives out stock)*
- [ ] **1.5** `TableService.accept` — `handed_out → collected`, guarded
      *(item 2: waiter accepts to verify collection)*
- [ ] **1.6** merchant-side projection — only the caller's own lines/subtotal
- [ ] **1.7** `GET /api/waiter/tables?tab=&q=` *(items 3 + 4)*
- [ ] **1.8** `POST /api/waiter/tables/:id/stalls/:merchantId/accept`
- [ ] **1.9** `GET /api/merchant/tables?status=`
- [ ] **1.10** `POST /api/merchant/tables/:id/hand-out`

## Group 2 — App screens (pos-app)

- [ ] **2.1** Waiter home: New / Paid / Collected tabs *(item 3)*
- [ ] **2.2** Waiter home: search over table label *(item 4)*
- [ ] **2.3** `TablePage`: per-stall status chip
- [ ] **2.4** `TablePage`: Accept button on `handed_out` sections
- [ ] **2.5** `MerchantShell`: 4th "Tables" tab
- [ ] **2.6** Stall tables screen: list + status filter + Hand out button

## Group 3 — POS UI fixes (pos-app)

- [ ] **3.1** `BasketPanel`: cap at ~2 visible rows, scroll for more
      *("the cart still takes up more space in the bottom sheet")*
- [ ] **3.2** `BasketPanel`: newest line first
      *("display by new item for waiter to see that the list is being updated")*
- [ ] **3.3** Verify 3.1/3.2 land for **both** waiter (`AddItemsSheet`) and
      stall (`ChargePage`) *("this goes for waiters, and stalls accounts")*
- [ ] **3.4** `ChargePage`: collapse header + mode toggle while searching
      *("once you try search the 'charge' form covers most space")*
- [ ] **3.5** Reclaim top-screen height generally *("shifting the top buttons
      /searchbox up or find a way to make the top screen take less space")*

## Group 4 — Dashboard

- [ ] **4.1** Cashless → Catalogue: category tabs like the Menu tab
      *("display the stock like you have displayed under MENU")*

## Ship

- [ ] **5.1** api tests green
- [ ] **5.2** pos-app `flutter test` + `flutter analyze` green
- [ ] **5.3** dashboard build + tests green
- [ ] **5.4** Commit each repo on its branch
