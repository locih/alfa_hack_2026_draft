# Диаграмма состояний заявки

12 статусов, 22 разрешённых перехода. Источник истины — `app/states.py` (`TRANSITIONS`); тест `test_state_machine_is_closed` фиксирует состав.

```mermaid
stateDiagram-v2
    [*] --> DRAFT: создание
    DRAFT --> VERIFICATION: клиент отправил заявку
    VERIFICATION --> DECISIONING: данные получены, стоп-правил нет
    VERIFICATION --> MANUAL_REVIEW: источник недоступен после повторов
    VERIFICATION --> DECLINED: сработало стоп-правило / продукт недоступен
    AWAITING_DOCS --> VERIFICATION: клиент предоставил документы
    DECISIONING --> OFFER_READY: автоодобрение или встречное предложение
    DECISIONING --> MANUAL_REVIEW: грейд D, граница балла, сумма выше автолимита, флаги
    DECISIONING --> DECLINED: грейд E или нет допустимых условий
    MANUAL_REVIEW --> OFFER_READY: аналитик одобрил / изменил условия
    MANUAL_REVIEW --> AWAITING_DOCS: аналитик запросил документы
    MANUAL_REVIEW --> DECLINED: аналитик отказал (причины обязательны)
    OFFER_READY --> AWAITING_SIGNATURE: клиент принял
    OFFER_READY --> EXPIRED: срок оферты 14 дней истёк к моменту принятия
    AWAITING_SIGNATURE --> DISBURSING: код подтверждения верный
    DISBURSING --> DISBURSED: моделируемое зачисление
    DISBURSED --> [*]
    DECLINED --> [*]
    WITHDRAWN --> [*]
    EXPIRED --> [*]
    note right of DRAFT
        WITHDRAWN достижим из всех нетерминальных
        статусов, кроме DISBURSING (клиент отозвал
        заявку или отказался от предложения)
    end note
```

## Статус → что видит клиент

| Внутренний статус | Клиентский ярлык | Шаг степпера | Чей ход |
|---|---|---|---|
| DRAFT | Черновик | 1 Заявка | клиент |
| VERIFICATION | Проверяем данные | 2 Проверка | банк |
| AWAITING_DOCS | Нужны документы | 2 Проверка | **клиент** |
| DECISIONING | Оцениваем условия | 3 Решение | банк |
| MANUAL_REVIEW | Заявку рассматривает специалист | 3 Решение | банк |
| OFFER_READY | Предложение готово («Одобрено» / «Другие условия») | 3 Решение | **клиент** |
| AWAITING_SIGNATURE | Ожидает подписания | 4 Подписание | **клиент** |
| DISBURSING | Оформляем выдачу | 5 Выдача | банк |
| DISBURSED | Кредит выдан | 5 Выдача | — |
| DECLINED / WITHDRAWN / EXPIRED | Отказано / Заявка закрыта / Срок истёк | — | — |

Автоматические этапы (`VERIFICATION`, `DECISIONING`, `DISBURSING`) выполняет фоновый поток с паузой `STEP_DELAY_SEC`; клиентский интерфейс опрашивает сервер и меняет статус без перезагрузки.
