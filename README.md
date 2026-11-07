# GameBy Kanban (bot Discorda)

Autor: Mateusz Bartoszewicz

Kanban wewnątrz Discorda dla redakcji GameBy.pl. Zadania to posty na forum `#artykuly`, a kolumny to tagi statusu:
Pomysł, Przydzielone, W pisaniu, Do redakcji, Do publikacji, Opublikowane. Bot dodaje do tego żywą tablicę na osobnym kanale
(kolumny jako osobne kolorowe bloki), kartę z przyciskami w każdym poście, formularz „Dodaj zadanie”, filtry i codzienne podsumowanie.
Opcjonalnie dochodzi **tablica z przeciąganiem kart**: strona działająca w przeglądarce i (na małych serwerach) jako Activity w Discordzie
(rozdział „Tablica z przeciąganiem” niżej). Bez niej wszystko działa jak dotąd.
Dla zarządu dochodzą **rozliczenia z osobami piszącymi**: stała stawka za tekst, premie, a na początku miesiąca szkic protokołów (PDF) do zatwierdzenia i wysyłka
do każdej osoby w wiadomości prywatnej (rozdział „Rozliczenia”). Bez ustawienia `FINANCE_USER_IDS` ta część jest wyłączona.

## Jak to wygląda w praktyce

**Żywa tablica** (kanał, np. `#tablica` w kategorii REDAKCJA) to siedem wiadomości bota: nagłówek z licznikami i sześć kolumn, każda w kolorze statusu.
Bot sam je edytuje po każdej zmianie (z opóźnieniem około dwóch sekund), więc na tablicy nie trzeba wpisywać żadnych komend.
Każde zadanie to jedna linia: kolorowa kropka terminu, tytuł (link do posta), osoba i termin.

```
🔴 🔥 Recenzja nowej konsoli  @Oliwia · 20.10, po terminie o 4 dni
🟡 Poradnik zakupowy: myszki  @Marek · 26.10, za 2 dni · publikacja 30.10
🟢 Recenzja gry na premierę  @Oliwia · tekst oddany · publikacja 12.11, za 19 dni
📝 Recenzja padu do PC  @Oliwia · tekst oddany
⚪ Pomysł na felieton · bez osoby
```

Kropki: 🔴 po terminie, 🟠 dziś lub jutro, 🟡 do 3 dni, 🟢 później, ⚪ bez terminu, 📝 tekst oddany, ✅ opublikowane. 🔥 oznacza zadanie pilne (idzie na górę kolumny).

### Dwa terminy: oddanie tekstu i publikacja

Każde zadanie może mieć **dwa niezależne terminy**:

- **Oddanie tekstu**: do kiedy autor ma przesunąć zadanie do **Do redakcji** (przycisk na karcie nazywa się wtedy **Oddaj do redakcji ▶**; na stronie wystarczy przeciągnąć kartę do kolumny Do redakcji),
- **Publikacja**: do kiedy tekst musi wyjść, np. premiera gry albo koniec embarga. Ten termin jest **opcjonalny**.

Bot liczy zawsze **jeden** z nich, ten, który w danej chwili pilnuje zadania:

| Etap zadania | Który termin się liczy | Co widać po terminie |
| --- | --- | --- |
| Pomysł, Przydzielone, W pisaniu | wcześniejszy z dwóch (przy tej samej dacie: oddanie) | 🔴 „po terminie o N dni”; drugi termin stoi obok jako informacja |
| Do redakcji, Do publikacji | tylko publikacja | 🔴 „publikacja 24.10, po terminie o 1 dzień” |
| Opublikowane | żaden | ✅, nigdy „po terminie” |

Jeśli zadanie nie ma terminu publikacji, po oddaniu tekstu działa tak jak wcześniej: 📝 i dopisek „tekst oddany”, nic nie jest czerwone.
Jeśli ma tylko termin publikacji (bez terminu oddania), liczy się on od początku.

Konsekwencje w poszczególnych miejscach:

- na tablicy kropka i odliczanie dotyczą terminu, który się liczy, np. `🟠 … · 25.10, jutro · publikacja 28.10` albo `🟢 … · tekst oddany · publikacja 28.10, za 4 dni`,
- na karcie w poście są dwa pola: **Oddanie tekstu** (po oddaniu z dopiskiem „tekst oddany”, zapisana data zostaje) i **Publikacja**,
- na stronie karta ma plakietkę terminu, który się liczy (po oddaniu: „publikacja 28 paź”, na czerwono po terminie), a drugi termin jako szarą notatkę; opublikowane nie mają plakietek,
- liczniki „po terminie” i „termin w ciągu 3 dni” w nagłówku, filtr **Po terminie**, sortowanie kolumn i podsumowanie dnia używają tego samego terminu. Zadanie po oddaniu, z premierą za kilka dni, trafi więc do „Termin w ciągu 3 dni”, a po premierze do „Po terminie”,
- ping w podsumowaniu dnia dostaje tylko autor, który **jeszcze pisze**. Termin publikacji po oddaniu tekstu pilnuje redakcja, więc autor nie jest już wołany.

Jeśli redakcja odeśle tekst do poprawek (status wraca do W pisaniu albo wcześniejszy), znowu liczy się wcześniejszy z dwóch terminów, więc zadanie może stać się „po terminie” od nowa.
Tablica nie pokazuje, kiedy dokładnie tekst oddano, więc nie wyliczy „oddano 2 dni po terminie” (datę oddania zapisują tylko rozliczenia, widoczne dla zarządu). Które statusy znaczą „tekst oddany”, ustala jedna stała `WRITING_DONE` na początku `src/board.js`, a który termin się liczy, funkcja `activeDue` w tym samym pliku.

Termin publikacji ustawisz: w formularzu nowego zadania (nagłówek tablicy, strona), w komendzie `/zadanie … publikacja:12.11`, przyciskiem **Terminy** na karcie, komendą `/edytuj publikacja:…` albo w oknie zadania na stronie.
Posty zakładane ręcznie nie mają linii z terminem publikacji (bot czyta z treści tylko `Odpowiedzialny:` i `Termin:`), więc publikację ustawia się w nich kartą, komendą lub stroną.

**Nagłówek tablicy** ma przycisk **Dodaj zadanie** (formularz: tytuł, osoba z listy, oddanie tekstu, publikacja, opis) oraz menu **Pokaż mi…**:
Moje zadania, Bez osoby, Po terminie, Pilne, Wszystkie otwarte. Lista z menu jest prywatna, widzisz ją tylko Ty.

**Karta w każdym poście** to wiadomość bota z aktualnym statusem, osobą, terminami (oddanie tekstu i publikacja) i priorytetem oraz przyciskami:

- menu **Zmień status** oraz przyciski **Wstecz** i **Dalej**,
- **Biorę to**: bierze wolne zadanie (status z Pomysł zmienia się na Przydzielone). Gdy zadanie ma już osobę, przycisk zmienia się na **Zwolnij**, którym zdejmiesz osobę, ale tylko ze swojego zadania (cudze zwolnisz komendą `/edytuj zwolnij`). Cudzego zadania nie przejmiesz,
- menu **Przydziel osobę**: wybierasz kogoś z listy. Osoba dostaje wiadomość w poście z oznaczeniem (to jedyne miejsce, w którym bot kogoś oznacza poza opcjonalnym podsumowaniem),
- **Terminy**: okno z dwoma polami, na oddanie tekstu i na publikację (`05.11`, `05.11.2026`, `2026-11-05`; puste pole usuwa dany termin),
- **Pilne** / **Zdejmij pilne**.

Przyciski karty niosą docelowy stan („ustaw Przydzielone”, „pilne włączone”), więc podwójne kliknięcie na wolnym telefonie niczego nie przesuwa dwa razy ani nie cofa.
Status zmienia się sam tylko w jednym przypadku: przydział osoby przestawia Pomysł na Przydzielone, a zwolnienie osoby cofa Przydzielone na Pomysł.
Zadania na dalszych etapach zostają tam, gdzie są.

## Komendy

- `/ustaw-tablice`: ustawia żywą tablicę na kanale, na którym ją wpiszesz. Tylko kierownictwo i moderacja („Zarządzanie wątkami”), tylko na zwykłym kanale tekstowym niewidocznym dla community.
  Wpisanie jej na innym kanale przenosi tablicę (stara znika).
- `/zadanie tytul [osoba] [termin] [publikacja] [opis]`: zakłada post na forum z kartą. `termin` to oddanie tekstu, `publikacja` to premiera lub embargo (oba opcjonalne). Z osobą: Przydzielone, bez: Pomysł.
- `/edytuj [termin] [publikacja] [osoba] [zwolnij]`: w poście zmienia termin oddania tekstu lub termin publikacji (`brak` usuwa dany termin; drugiego to nie rusza), osobę albo zdejmuje osobę. Działa w każdym poście na forum, także założonym ręcznie.
- `/tablica [moje] [publicznie]`: tablica jednorazowo, w jednej wiadomości (prywatnie albo na bieżący kanał redakcji). Przydaje się na telefonie, gdy nie chcesz wchodzić na kanał z tablicą.
- `/panel`: dodaje świeżą kartę do posta (zastępuje poprzednią). Przydaje się w starych postach z panelem z poprzedniej wersji bota.
- `/podsumowanie`: to samo, co bot wysyła rano.
- `/rozliczenia stawka | stawki | premia | social | szkic`: tylko zarząd (`FINANCE_USER_IDS`), odpowiedzi są prywatne. Opis w rozdziale „Rozliczenia” niżej.

## Rozliczenia z osobami piszącymi (tylko zarząd)

**Co to robi.** Każda osoba ma stałą stawkę za tekst. Tekst liczy się do miesiąca, w którym został **oddany do redakcji**, czyli przeszedł do statusu „Do redakcji”
(przyciskiem na karcie, na stronie albo ręczną zmianą tagu). Liczy się **pierwsze** oddanie: powrót do pisania na poprawki, ponowne oddanie i publikacja nie zmieniają tej daty.
Jeśli bot nie zobaczył zmiany (był wyłączony, np. przy redeployu), zapisze datę przy najbliższym przeglądzie forum (żywa tablica robi go co najwyżej co 10 minut), czyli z dniem wykrycia.
**Ważne dla redakcji:** autor po oddaniu tekstu przesuwa kartę do **Do redakcji**. Jeśli karta pójdzie z „W pisaniu” od razu do „Do publikacji” lub „Opublikowane”, datą oddania będzie dzień tej zmiany, czyli zwykle dzień publikacji.
Taką datę poprawisz w poście z zadaniem: `/rozliczenia oddano data:28.10` (`data:brak` usuwa datę). Daty tekstu z zatwierdzonego protokołu zmienić się nie da.
Pierwszego dnia roboczego następnego miesiąca, od godziny podsumowania (`DIGEST_HOUR`), bot przygotowuje szkic protokołów za poprzedni miesiąc i wysyła **Tobie** w wiadomości prywatnej.
Dopiero po Twoim zatwierdzeniu każda osoba dostaje swój protokół (PDF) w wiadomości prywatnej z prośbą, żeby sprawdziła zestawienie, dopisała liczbę godzin, podpisała i odesłała e-mailem.

**Włączenie.** W `.env` (na Railway w zakładce Variables) ustaw `FINANCE_USER_IDS`: numery osób z zarządu, oddzielone przecinkami
(numer: Discord, Ustawienia, Zaawansowane, Tryb dewelopera włączony, potem prawy przycisk na osobie, „Kopiuj ID użytkownika”).
Opcjonalnie `PROTOCOL_ISSUER` (nazwa zleceniodawcy na protokole, domyślnie `GameBy.pl`), `PROTOCOL_RETURN_EMAIL` (adres, na który osoby mają odsyłać podpisane protokoły) i `PROTOCOL_TITLE`
(tytuł dokumentu, domyślnie „Protokół rozliczenia tekstów”). Bot zapisuje wtedy początek rozliczeń: protokół powstanie za miesiąc, w którym włączyłeś funkcję (jeśli włączysz ją w październiku, pierwszy szkic przyjdzie na początku listopada za październik).

**Krok po kroku.**

1. **Stawki:** `/rozliczenia stawka osoba:@ktoś kwota:150 imie:Imię Nazwisko`. Kwotę wpisujesz tak, jak ma stać w protokole (`150`, `150,50`; bot niczego nie przelicza na brutto ani netto). `imie` to imię i nazwisko do protokołu
   (domyślnie nazwa z serwera); przy zmianie samej kwoty imię zostaje. `/rozliczenia stawki` pokazuje wszystkie stawki (tylko Tobie), a `kwota:brak` usuwa stawkę.
2. **Premie:** w poście z zadaniem `/rozliczenia premia kwota:20 opis:post na Facebooku`. Można dodać po publikacji i kilka do jednego tekstu. Premia trafia do miesiąca, w którym tekst oddano, jeśli jego protokół nie jest jeszcze zatwierdzony,
   a w przeciwnym razie do bieżącego miesiąca. `kwota:brak` usuwa nierozliczone premie tego tekstu.
   **Premia za social bez komendy:** zarząd ustawia raz jedną stałą kwotę dla wszystkich (`/rozliczenia social kwota:20`, `kwota:brak` ją usuwa). Potem na karcie w poście jest przycisk **Premia za social**, a w oknie zadania na stronie pole
   „Tekst udostępniono na social mediach”. Osobę z zadania wystarczy poprosić o kliknięcie: to **zgłasza** premię (na karcie i na tablicy pojawia się „social: zgłoszone”). Zgłoszenia zatwierdzasz na szkicu w menu
   „Zatwierdź premie za social” (trafiają do rozliczanego miesiąca) albo od razu z karty lub strony przyciskiem **Zatwierdź social**; gdy sam klikniesz przycisk na karcie, premia jest zatwierdzona od razu. Zatwierdzona premia dostaje kwotę
   z chwili zatwierdzenia (późniejsza zmiana stałej jej nie rusza) i wpisuje się do protokołu jako „udostępnienie w social mediach”. Zgłoszenie cofa osoba z zadania albo zarząd, zatwierdzoną premię usuwa tylko zarząd, a po zatwierdzeniu protokołu jest zamrożona.
   Na zadanie przypada jedna taka premia. Bez ustawionej kwoty zgłaszać można, ale zatwierdzić się nie da.
3. **Szkic:** bot wysyła Ci najpierw podgląd PDF-ów (po 10 w wiadomości), a na końcu podsumowanie: kto, ile tekstów i premii, kwota, oraz ostrzeżenia. Ręcznie: `/rozliczenia szkic` (poprzedni miesiąc) albo `/rozliczenia szkic miesiac:2026-10`.
   Ostrzeżenia: **bez stawki** (osoba nie dostanie protokołu, ustaw stawkę), **bez osoby** (przydziel osobę na karcie) i **bez daty oddania** (menu do zaznaczenia, patrz niżej). Po poprawkach użyj **Odśwież szkic**.
4. **Zatwierdzenie:** **Wyślij do osób**, potem potwierdzenie („Tak, wyślij”). Przed wysyłką bot sprawdza jeszcze raz, czy nic się nie zmieniło od szkicu (nowy tekst, premia, stawka, zmiana statusu): jeśli tak,
   nic nie wysyła i pokazuje nowy szkic do ponownego zatwierdzenia. Po wysyłce dane są **zamrożone**: teksty i premie z protokołu nie wejdą do żadnego następnego i nie zmienisz ich wstecz.
   Osobom, do których wiadomość nie dotarła (mają wyłączone wiadomości prywatne od członków serwera), bot pokaże listę i przycisk **Ponów wysyłkę**.
5. **Zła data oddania:** w poście z zadaniem `/rozliczenia oddano data:28.10` (także `28.10.2026` albo `2026-10-28`). Bot odpowie, za który miesiąc tekst się teraz rozliczy, i podpowie, czy trzeba odświeżyć szkic albo zrobić protokół uzupełniający.
6. **Uzupełnienie:** teksty, które zostały poza protokołem (np. osobie brakowało stawki), rozliczysz później: `/rozliczenia szkic miesiac:2026-10` po wysłaniu tworzy protokół uzupełniający tylko z tego, co zostało. „Pomiń ten miesiąc” zamyka szkic bez rozliczania.

**Pierwszy miesiąc.** Teksty oddane przed wdrożeniem nie mają daty oddania. Szkic pokaże je w menu „Zaznacz teksty oddane w: …” (tylko posty założone w tym lub poprzednim miesiącu, żeby nie wracały stare opublikowane teksty);
zaznaczasz te, które faktycznie oddano w rozliczanym miesiącu, a szkic odświeża się sam.

**Kto co widzi.** Stawki, kwoty, premie i szkice widzi tylko zarząd: odpowiedzi komend są prywatne, szkic idzie do wiadomości prywatnych, a kwoty nie trafiają na kartę zadania, tablicę, stronę z tablicą, podsumowanie dnia ani do logów.
Wyjątek to sam stan premii za social (brak, zgłoszona, zatwierdzona): widać go na karcie, na kartach i w oknie zadania na stronie, ale nigdy z kwotą. Żywy nagłówek tablicy w Discordzie go nie pokazuje.
Osoba widzi wyłącznie swój protokół, dopiero po zatwierdzeniu. Uwaga: stawki i kwoty leżą w pliku stanu (`state.json`), więc widzi je każdy, kto ma dostęp do wolumenu bota lub projektu na Railway.

**Co jest w PDF.** Tytuł i miesiąc, zleceniodawca, imię i nazwisko osoby, tabela tekstów (tytuł, data oddania, stawka, kwota), premie, suma „Razem do wypłaty”, pole na liczbę przepracowanych godzin, pole na uwagi i miejsca na dwa podpisy.
Suma, godziny i podpis są zawsze na jednej stronie. **Treść to roboczy szablon, nie wzór sprawdzony przez księgową ani prawnika:** bot nie wie, czy rozliczacie się umową zlecenia, o dzieło czy fakturą, i nie liczy podatków ani składek. Pokaż protokół księgowej przed pierwszą wysyłką
i daj mi znać, co zmienić (albo przyślij własny wzór), a dopasuję układ i brzmienie.


Raz dziennie, w dni robocze, między 9:00 a 15:00 czasu warszawskiego, na `#ogolne` w kategorii REDAKCJA (jeśli bot wystartuje później niż 9:00, nadrobi to w tym oknie).
Sekcje: Po terminie, Termin w ciągu 3 dni, Czeka na redakcję, Gotowe do publikacji oraz **Bez osoby, do wzięcia** (do 8 pozycji; zadania z Do redakcji i Do publikacji są w swoich sekcjach). Liczy się ten termin, który pilnuje zadania (patrz „Dwa terminy”): po oddaniu tekstu zadanie jest „po terminie” dopiero wtedy, gdy minie termin publikacji, i wtedy pokazuje się w sekcji „Po terminie” zamiast w „Czeka na redakcję” (nie powtarza się w obu).
Gdy nic nie czeka, nic nie wysyła. Podsumowanie zawiera tytuły z prywatnego forum, więc bot odmawia wysyłki na kanał widoczny dla wszystkich.

## Uprawnienia

Statusy „Do publikacji” i „Opublikowane” (oraz cofnięcie z nich) ustawia tylko osoba z uprawnieniem „Zarządzanie wątkami” (kierownictwo, moderacja).
Reszta zespołu przesuwa zadania między pozostałymi statusami. Wszystkie przyciski i komendy działają tylko dla osób, które widzą forum `#artykuly`;
członkowie community dostaną odmowę. Przydzielić można tylko osobę, która widzi forum (inaczej dostałaby oznaczenie do zadania, którego nie otworzy).
Tablicę i podsumowanie bot wysyła tylko na kanał, którego nie widzi ani @everyone, ani żadna rola bez dostępu do forum; sprawdza to przy każdym zapisie, więc jeśli ktoś później otworzy kanał dla innej roli,
bot przestanie na nim pisać i zapisze to w logu. Uprawnienia nadane pojedynczym osobom (nie rolom) nie są sprawdzane.

## Gdzie bot trzyma dane

Status to tag posta, więc żyje w Discordzie. **Osoba, terminy (oddanie tekstu i publikacja) i priorytet ustawione kartą lub komendą zapisuje bot w pliku stanu** (`state.json` w wolumenie Dockera `kanban-data`),
razem z numerem karty w poście i miejscem żywej tablicy. Karta w poście pokazuje te dane, ale bot nie odczytuje ich z powrotem z Discorda.
Konsekwencje: `docker compose down -v` albo usunięcie wolumenu kasuje osoby, terminy i priorytety (statusy zostają), a tablicę trzeba ustawić od nowa (`/ustaw-tablice`).
Kopia zapasowa pliku:

```
docker compose cp kanban:/data/state.json ./state-kopia.json
```

**Rozliczenia** są w tym samym pliku: top-level `fin` (stawki, imiona do protokołów, historia protokołów z zamrożonymi zestawieniami i wynikiem wysyłki), a w danych zadania klucze `h` (data oddania do redakcji),
`s` (miesiąc rozliczenia tekstu), `b` (lista premii; premie za social mają `k: "social"`) i `x` (zgłoszona premia za social); w `fin` jest też `social`, czyli stała kwota tej premii. Kopia pliku zawiera więc stawki i kwoty; traktuj ją jak dane poufne.

Posty założone ręcznie albo przez poprzednią wersję bota: dopóki nikt nie ustawi osoby lub terminu kartą, bot czyta je jak dawniej z pierwszej wiadomości posta
(linie `Odpowiedzialny: @osoba` i `Termin: 05.11.2026`, wymaga Message Content Intent, patrz niżej), a bez tych linii osobą jest autor posta.
Termin bez roku (`05.11`) w takiej linii bot czyta jako rok najbliższy dzisiejszej dacie. Te dane bot odświeża co najwyżej raz na 5 minut.
Raz ustawione kartą mają pierwszeństwo przed linią w treści.

## Instalacja (Windows + Docker Desktop)

### 1. Aplikacja w Discordzie

1. Wejdź na discord.com/developers/applications, kliknij **New Application** i nazwij ją np. „GameBy Kanban”.
   Najlepiej osobna aplikacja, a nie ta od skryptu budującego serwer (tamtego bota po konfiguracji usuwasz z serwera).
2. Zakładka **Bot** → **Reset Token** → skopiuj token. Nikomu go nie wysyłaj i nie wklejaj do czatu.
3. Opcjonalnie, żeby bot czytał terminy i osoby z linii w postach założonych ręcznie: w tej samej zakładce, w sekcji **Privileged Gateway Intents**,
   włącz **Message Content Intent**, a w pliku `.env` ustaw `MESSAGE_CONTENT=1`. Dla bota na jednym serwerze to zwykły przełącznik, bez weryfikacji.
   Karty, przyciski i żywa tablica działają także bez tego.
4. Zakładka **General Information** → skopiuj **Application ID**.
5. Zaproś bota, wstawiając swoje Application ID w link (uprawnienia są już policzone):

```
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=326417599488
```

6. Na serwerze: Ustawienia serwera → Członkowie → bot → nadaj mu rolę **Redakcja**. Bez tego bot nie widzi kategorii REDAKCJA ani forum.
   Bot nie powinien mieć roli z uprawnieniem Administrator: uprawnienia z linku mają wystarczyć, a jeśli czegoś zabraknie, ostrzeże o tym w logach przy starcie.
7. Sprawdź tagi forum: w ustawieniach kanału `#artykuly` → Tagi, tagi **Do publikacji** i **Opublikowane** muszą mieć zaznaczone **Moderowany**
   (skrypt budujący serwer robi to sam). Bez tego każdy autor posta może ustawić je ręcznie w Discordzie, z pominięciem bota. Bot ostrzega o tym w logach przy starcie.
   W ustawieniach forum ustaw też **Ukryj po nieaktywności: 1 tydzień** (skrypt też to robi), żeby zadania rzadko trafiały do archiwum.

### 2. Pliki na komputerze

1. Rozpakuj paczkę do folderu, np. `C:\gameby-kanban`.
2. Skopiuj `.env.example` jako `.env` i uzupełnij `DISCORD_TOKEN` oraz `GUILD_ID`.
   W Notatniku zapisz plik jako **Wszystkie pliki** o nazwie `.env` (inaczej Notatnik doda `.txt`).

### 3. Start

W PowerShellu w tym folderze:

```
docker compose up -d --build
docker compose logs -f
```

W logach powinno być: „Zalogowano jako …”, „Zarejestrowano komendy …” i „tagi statusu są na miejscu”. Linie zaczynające się od „UWAGA” to ostrzeżenia
(brak uprawnień bota, niemoderowane tagi, kanał podsumowania widoczny dla wszystkich): przeczytaj je od razu.
Komendy pojawiają się na serwerze od razu (po aktualizacji odśwież Discorda skrótem Ctrl+R). Zatrzymanie: `docker compose down` (bez `-v`!). Po zmianie `.env`: `docker compose up -d`.

Bot działa tylko wtedy, gdy działa Docker Desktop. Kontener ma ustawiony automatyczny restart, więc wróci po uruchomieniu Dockera.

### 4. Aktualizacja z poprzedniej wersji

Rozpakuj nową paczkę nad starą (zostaw swój `.env`) i uruchom `docker compose up -d --build`. Wolumen ze stanem zostaje, więc ustawienia i data ostatniego podsumowania się zachowują.
Stare panele w postach nadal działają, a po pierwszym kliknięciu zamieniają się w nową kartę. Na starszych postach możesz też użyć `/panel`.

### 5. Żywa tablica

1. Utwórz kanał tekstowy w kategorii REDAKCJA, np. `#tablica` (albo użyj istniejącego). Najlepiej taki, na którym nikt inny nie pisze: bot ma tam tylko swoje wiadomości.
2. Wejdź na ten kanał i wpisz `/ustaw-tablice` (potrzebne uprawnienie „Zarządzanie wątkami”).
3. Gotowe. Jeśli ktoś usunie wiadomość tablicy, bot odtworzy ją najpóźniej po 10 minutach.

### 6. Pierwszy test

1. Na `#tablica` kliknij **Dodaj zadanie**, wpisz tytuł „Test kanbana” i zatwierdź. Powstaje post z kartą, a tablica odświeża się sama.
2. W poście kliknij **Biorę to**, potem **Dalej**, potem **Terminy** i wpisz datę oddania (publikację możesz zostawić pustą). Tablica ma pokazać zmiany w ciągu kilku sekund.
3. Z menu **Pokaż mi…** wybierz **Moje zadania**.
4. Jako osoba bez uprawnienia „Zarządzanie wątkami” spróbuj ustawić „Do publikacji”: powinna dostać odmowę. Potem usuń post testowy.

## Tablica z przeciąganiem (strona i Activity)

Discord nie pozwala przeciągać wiadomości, więc przeciąganie daje osobna strona, którą bot sam udostępnia. Jedna i ta sama strona działa na dwa sposoby:

- **w przeglądarce** (komputer, telefon): logujesz się kontem Discord i widzisz tablicę pod adresem `PUBLIC_URL`. Bez limitu liczby osób, wystarczy być na serwerze i widzieć forum;
- **jako Activity w Discordzie** (przycisk „Tablica z przeciąganiem” na żywej tablicy): to samo, ale wewnątrz klienta Discorda. Aplikacja bez weryfikacji przez Discorda
  działa tak tylko na serwerach z mniej niż 25 członkami i tylko dla członków zespołu aplikacji oraz testerów. Gdy serwer jest większy, zostaje wersja w przeglądarce.

Przeciągasz kartę myszą (próg 5 px, żeby zwykłe kliknięcie otwierało szczegóły) albo na telefonie za uchwyt na karcie lub długim przytrzymaniem (około 0,35 s).
Przy krawędzi ekranu tablica przewija się sama, Esc anuluje przeciąganie. Na wąskim ekranie kolumny są zakładkami, a kartę upuszczasz na zakładkę.
Kliknięcie karty otwiera okno ze szczegółami: osoba, oba terminy, pilne i przyciski statusu (to alternatywa dla klawiatury, bo samego przeciągania klawiszami nie ma).
Tablica odświeża się sama co kilka sekund (wstrzymuje się w tle, w trakcie przeciągania i zapisu), więc zmiany kolegów pojawiają się bez przeładowania.

Uprawnienia są te same co przy przyciskach bota i sprawdzane po stronie bota przy każdej zmianie (nie tylko przy logowaniu):
status „Do publikacji” i „Opublikowane” (oraz wyjście z nich) przesuwa tylko osoba z „Zarządzanie wątkami”, a strona i tak pokazuje te kolumny jako zablokowane dla reszty.
Zalogować się i zobaczyć zadania może wyłącznie osoba, która jest na serwerze i widzi forum `#artykuly`.

### A. Co jest potrzebne

1. **Publiczny adres HTTPS**, pod którym strona jest dostępna z internetu (to wymóg Discorda, także dla Activity). Najprościej: darmowy Cloudflare Tunnel (niżej).
   Potrzebna jest domena w Cloudflare albo darmowa domena z jego panelu; samo `localhost` wystarczy tylko do prób na własnym komputerze.
2. **Sekret aplikacji** (`DISCORD_CLIENT_SECRET`) i ten adres (`PUBLIC_URL`) w pliku `.env`.
3. Komputer z uruchomionym Dockerem: **strona działa tylko wtedy, gdy działa bot** (tak samo jak reszta). Gdy komputer śpi, tablica w przeglądarce się nie otworzy.

### B. Developer Portal (ta sama aplikacja co bot)

1. **OAuth2** → **Client Secret** → **Reset Secret**, skopiuj do `.env` jako `DISCORD_CLIENT_SECRET` (to nie jest token bota).
2. **OAuth2** → **Redirects** → dodaj dwa adresy: `<PUBLIC_URL>/auth/callback` (logowanie w przeglądarce) oraz `https://127.0.0.1` (wymaga go logowanie wewnątrz Activity). Zapisz.
3. Tylko dla Activity: zakładka **Activities** → włącz **Enable Activities**. W **URL Mappings** ustaw `/` na adres strony **bez** `https://` (np. `tablica.gameby.pl`).
   W **Settings** Activities dodaj w razie potrzeby obsługiwane platformy (komputer, telefon).
4. Tylko dla Activity: osoby, które mają ją otworzyć, muszą należeć do **zespołu aplikacji** (Developer Portal → Teams) lub być jej testerami; dopóki aplikacja nie jest zweryfikowana, nikt inny jej nie uruchomi.
   Nazwy zakładek w Developer Portal Discord zmienia dość często, więc jeśli któraś wygląda inaczej, szukaj ustawień Activities, mapowania URL i testerów.
5. Tylko dla `MEMBERS_INTENT=1`: zakładka **Bot** → **Privileged Gateway Intents** → włącz **Server Members Intent**.

### C. Plik `.env`

```
DISCORD_CLIENT_SECRET=wklej_sekret
PUBLIC_URL=https://tablica.gameby.pl
TRUST_PROXY=1
ACTIVITY=1
```

`TRUST_PROXY=1` (domyślne w `.env.example`) każe botowi brać adres klienta do limitów zapytań z nagłówków tunelu. Przy tunelu jest to konieczne: bez tego cały ruch wygląda jak jedna osoba
i jeden napastnik, który wyczerpie limit logowań, zablokowałby logowanie całej redakcji. Jest to bezpieczne przy dołączonym `docker-compose.yml`, bo port strony jest wystawiony tylko na `127.0.0.1`.
Ustaw `0` tylko wtedy, gdy uruchamiasz bota inaczej (bez tunelu, z portem dostępnym z innych komputerów). `ACTIVITY=1` ustaw dopiero po włączeniu Activities w kroku B3.
Po zmianie `.env`: `docker compose up -d --build`. W logach pojawi się linia „Strona z tablicą: port 8080, adres …”; na żywej tablicy dojdzie przycisk (lub tylko link, gdy `ACTIVITY=0`).

### D. Tunel Cloudflare (bez otwierania portów na routerze)

1. Panel Cloudflare (konto, na którym jest domena) → **Networking** → **Tunnels** (w starszych wersjach panelu: Zero Trust → Networks → Tunnels) → **Create a tunnel**, nazwij np. `gameby-tablica` i kliknij **Create Tunnel**.
2. W pokazanym poleceniu instalacyjnym (system: Docker) skopiuj sam token, czyli wartość po `--token`, do `.env` jako `TUNNEL_TOKEN`. Samego polecenia nie uruchamiaj: tunel uruchomi `docker compose`.
3. W tunelu zakładka **Routes** → **Add route** → **Published application**: **Subdomain** `tablica`, **Domain** `gameby.pl` (lub Twoja), **Service URL** `http://kanban:8080`. To nazwa usługi z `docker-compose.yml`, nie localhost.
4. Start: `docker compose --profile tunnel up -d --build`. Bez `--profile tunnel` tunel się nie uruchomi (bot i strona działają wtedy tylko na `127.0.0.1:8080` tego komputera).
5. Sprawdź `https://tablica.gameby.pl/healthz` (ma odpowiedzieć „ok”) i otwórz stronę główną.

Obraz tunelu jest przypięty do konkretnej wersji w `docker-compose.yml`. Numer wersji wziąłem ze spisu stron trzecich, nie z Docker Hub, więc jeśli `docker compose pull` go nie znajdzie,
wpisz aktualną wersję z hub.docker.com/r/cloudflare/cloudflared/tags (przypięta wersja jest celowa, żeby aktualizacja nie zmieniła niczego bez Twojej wiedzy).

### E. Sprawdzenie

1. Otwórz `PUBLIC_URL` w przeglądarce → **Zaloguj przez Discord** → zgoda → tablica z kolumnami. Pierwsze logowanie pokazuje zgodę Discorda (zakresy `identify` i `guilds.members.read`);
   kolejne przechodzą bez pytania.
2. Przeciągnij kartę „Test kanbana” z Pomysł na Przydzielone: w poście na forum zmieni się tag i karta, a żywa tablica odświeży się sama.
3. Spróbuj przeciągnąć kartę do „Do publikacji” jako osoba bez „Zarządzanie wątkami”: karta wraca, a strona pokazuje komunikat.
4. Activity: na żywej tablicy kliknij **Tablica z przeciąganiem**. Jeśli Discord odmówi (za duży serwer, brak roli testera), dostaniesz link do wersji w przeglądarce.

### Bezpieczeństwo i prywatność

- Sesje są tylko w pamięci bota (nic nie trafia na dysk). Ciasteczko jest `HttpOnly`, `SameSite=Lax`, a w przeglądarce zmiany są przyjmowane tylko z `PUBLIC_URL` (ochrona przed CSRF).
- W przeglądarce bot po zalogowaniu odwołuje token OAuth w Discordzie, bo do dalszej pracy potrzebny jest tylko numer osoby. W Activity token wraca do klienta Discorda,
  bo SDK potrzebuje go do uwierzytelnienia w kliencie; nasze API używa wtedy osobnej sesji, a nie tego tokenu.
- Strona ma ścisłe CSP (bez skryptów i stylów w treści strony), a ramkę można osadzić tylko w Discordzie. Limity: 240 zapytań na minutę na sesję, 30 prób logowania w Activity i 40 w przeglądarce na minutę z jednego adresu (IPv6 liczony po sieci /64) oraz wspólny budżet 120 logowań na minutę dla całej strony,
  który chroni limity Discorda przed zalewem z wielu adresów (wada: przy takim ataku i redakcja musi chwilę poczekać).
- Token tunelu (`TUNNEL_TOKEN`) trafia tylko do usługi tunelu, nie do kontenera z botem. Kontener bota działa bez uprawnień systemowych (`cap_drop: ALL`, `no-new-privileges`) jako zwykły użytkownik.
- Awatary bot pobiera sam i wysyła w odpowiedzi, więc przeglądarka nie łączy się z cdn.discordapp.com.
- Adres `PUBLIC_URL` jest publiczny, ale bez zalogowania kontem z dostępem do forum nic nie pokazuje (tytuły zadań są z prywatnego forum). Nie ma wyjątków ani linków gościnnych.

## Railway zamiast komputera

Ten sam obraz może działać w chmurze Railway: bot jest wtedy dostępny całą dobę, a komputer redakcji nie musi być włączony. Zmiany w kodzie są małe (patrz niżej), a adres, aplikacja w Developer Portal i dane zostają te same.
Tunel Cloudflare przestaje być potrzebny, bo ruch z internetu przyjmuje Railway.

**Co jest inne niż na komputerze**

- Railway sam ustawia zmienną `PORT`, a bot ją rozumie (`HTTP_PORT` nadal ma pierwszeństwo, jeśli ją ustawisz).
- Adres klienta do limitów logowania bot bierze z nagłówka `X-Real-IP`, który brama Railway nadpisuje: ustaw `TRUST_PROXY=1` i `PROXY_TYPE=railway`. Nie zostawiaj `PROXY_TYPE=cloudflare` na Railway ani odwrotnie:
  nagłówek usługi, której nie ma przed botem, mógłby podrobić każdy, kto zna adres strony, i wyłączyć limit prób logowania.
- Obraz nie ma już instrukcji `VOLUME`. Wolumen `kanban-data` w `docker-compose.yml` działa tak samo jak dotąd (zostaje podłączony w `/data`).
- Obraz działa jako użytkownik `node`, a wolumeny Railway są montowane jako root, więc na Railway ustaw `RAILWAY_RUN_UID=0`. Wtedy proces działa jako root **wewnątrz kontenera Railway**; to jest sposób opisany w dokumentacji Railway,
  ale oznacza słabszą izolację niż na komputerze (`cap_drop: ALL` i `no-new-privileges` z `docker-compose.yml` nie obowiązują).

**Ustawienia usługi (Variables)**: te same co w `.env` (`DISCORD_TOKEN`, `GUILD_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_URL`, `FORUM_NAME`, `ACTIVITY`, `DIGEST_*`, `TIMEZONE`…), a do tego:
`TRUST_PROXY=1`, `PROXY_TYPE=railway`, `RAILWAY_RUN_UID=0`. Nie ustawiaj `HTTP_PORT` ani `TUNNEL_TOKEN`. Sekrety wpisuj tylko tutaj (nie do repozytorium na GitHubie).
**`DISCORD_TOKEN` dodaj dopiero w chwili przełączenia** (krok 4 poniżej): dopóki go nie ma, bot na Railway nie łączy się z Discordem, więc nie może pracować równolegle ze starym i nie wystartuje z pustym stanem.

**Wolumen**: w usłudze dodaj Volume z punktem montowania `/data`. Bez niego `state.json` (osoby, terminy, priorytety, numery wiadomości żywej tablicy) znika przy każdym wdrożeniu.
Wolumen można mieć tylko jeden na usługę, a usługa z wolumenem nie ma replik; przy ponownym wdrożeniu jest krótka przerwa, bo stara wersja musi się zatrzymać, zanim ruszy nowa.

**Sprawdzenie zdrowia**: w Settings → Deploy ustaw Healthcheck Path na `/healthz`. Railway sprawdza to tylko przy wdrożeniu (nowa wersja musi odpowiedzieć „ok”, żeby wdrożenie uznać za udane; później już nie pilnuje). Wymaga `DISCORD_CLIENT_SECRET`, bo bez niego strony nie ma.

**Domena**: Settings → Networking → Custom Domain `tablica.gameby.pl`; Railway pokaże rekord CNAME (i czasem TXT) do wpisania w DNS. Ustaw go jako **DNS only** (szara chmurka w Cloudflare), nie jako proxied,
bo zachowanie nagłówków za podwójnym serwerem pośredniczącym nie jest sprawdzone. Adres się nie zmienia, więc w Developer Portal (Redirects, URL Mapping) nie zmieniasz niczego.

**Przeniesienie stanu** (żeby nie tracić osób, terminów i żywej tablicy):

1. Na komputerze zatrzymaj bota (`docker compose --profile tunnel stop`), żeby stan się już nie zmieniał, i skopiuj plik: `docker cp gameby-kanban:/data/state.json state.json`.
2. W PowerShellu zamień go na jedną linię base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("state.json"))`.
3. Wklej wynik jako zmienną `STATE_SEED_B64` w Railway **przed pierwszym uruchomieniem** (przy pustym wolumenie). Bot wczyta ją tylko wtedy, gdy pliku stanu jeszcze nie ma, i zapisze w logu „Wczytano stan początkowy…”.
4. Po pierwszym starcie usuń `STATE_SEED_B64` (zostawiona niczego nie psuje, ale jeśli kiedyś utworzysz nowy, pusty wolumen, przywróciłaby starą wersję).

Dokumentacja Railway nie podaje limitu długości zmiennej. Jeśli Railway odrzuci Twoją, plik można wgrać na wolumen przez Railway CLI (`railway ssh` oraz `scp`/`sftp`, które według dokumentacji sięgają też zamontowanego wolumenu; wymaga to klucza SSH zarejestrowanego w Railway). Tej drogi nie sprawdzałem.

**Kolejność przełączenia** (dwa boty na jednym tokenie edytują te same wiadomości, więc stary ma być wyłączony, zanim nowy zacznie pracować):

1. Zbuduj repozytorium na GitHubie (prywatne) z tej paczki; plik `.gitignore` pilnuje, żeby `.env` nie trafił do repozytorium.
2. Railway: New Project → GitHub Repository → to repozytorium. Pierwsze automatyczne wdrożenie zakończy się błędem, bo brakuje zmiennych (to normalne). Uzupełnij Variables **bez `DISCORD_TOKEN`**, dodaj Volume `/data`, ustaw Healthcheck Path i dodaj domenę w Railway (rekordu DNS jeszcze nie zmieniaj).
3. Zatrzymaj bota na komputerze (jak wyżej), zrób kopię stanu i wklej `STATE_SEED_B64`.
4. Dopiero teraz dodaj `DISCORD_TOKEN` w Railway i wdróż. W logach sprawdź: „Zalogowano jako…”, „Wczytano stan początkowy…”, „Strona z tablicą: port…”.
5. W Cloudflare usuń trasę tunelu `tablica.gameby.pl` (Routes) i jej rekord DNS, dodaj CNAME do Railway (DNS only). Poczekaj, aż Railway pokaże domenę jako aktywną (certyfikat).
6. Zaloguj się na `https://tablica.gameby.pl` i przesuń testową kartę. Dopiero potem usuń `STATE_SEED_B64`, a na komputerze `docker compose --profile tunnel down` (**bez** `-v`; wolumen z kopią zostaw na wszelki wypadek na kilka tygodni).

**Kolejne wersje na Railway**: wgraj zmienione pliki do repozytorium na GitHubie (cały folder `src`, `web`, `test` itd., nie tylko pojedyncze pliki), a Railway sam zbuduje i wdroży nową wersję. Plik stanu na wolumenie zostaje, a w wersji z dwoma terminami nic nie trzeba w nim przenosić
(nowy klucz `p` pojawia się tylko tam, gdzie ustawisz termin publikacji; rozliczenia dodają klucze `h`, `s`, `b`, `x` i `fin`, także bez migracji; żeby je włączyć, dopisz w Variables `FINANCE_USER_IDS`). Wdrożenie restartuje bota na kilka minut (wolumen potrafi się montować z opóźnieniem), a sesje logowania na stronie są w pamięci, więc po restarcie trzeba zalogować się ponownie.
Karty w postach przepisują się dopiero przy następnej zmianie w danym poście (albo po `/panel`), więc do tego czasu starsze karty pokazują jeszcze pole „Termin” zamiast dwóch pól; przycisk „Termin” na takiej karcie działa i otwiera już okno „Terminy”.

**Czego ta instrukcja nie obejmuje:** nie testowałem wdrożenia na prawdziwym Railway, a kolejność powyżej i nagłówki bramy opisuję według dokumentacji i odpowiedzi pracowników Railway, które nie są stałą gwarancją. Po pierwszym wdrożeniu sprawdź sam logowanie i to,
czy po kilkunastu błędnych próbach z jednego telefonu inna osoba nadal się zaloguje (to znaczy, że limity liczą adresy klientów, a nie jeden adres bramy).

## Ustawienia

Wszystkie w pliku `.env`, opisane w `.env.example`: forum (`FORUM_NAME` lub `FORUM_ID`, domyślnie `artykuly`), kanał podsumowania (`DIGEST_CHANNEL_NAME` lub `DIGEST_CHANNEL_ID`),
godzina i dni podsumowania (`DIGEST_HOUR`, `DIGEST_WEEKDAYS`), oznaczanie osób w podsumowaniu (`DIGEST_PING=1`), wyłączenie podsumowania (`DIGEST_ENABLED=0`),
strefa czasowa (`TIMEZONE`), strona z przeciąganiem (`DISCORD_CLIENT_SECRET`, `PUBLIC_URL`, `HOST_PORT`, `SESSION_HOURS`, `TRUST_PROXY`, `ACTIVITY`, `MEMBERS_INTENT`, `TUNNEL_TOKEN`; patrz rozdział wyżej), `REGISTER_COMMANDS=0` (nie rejestruj komend przy starcie), `BOARD_DEBOUNCE_MS` (po ilu milisekundach od zmiany odświeżać tablicę, domyślnie 2000), `STATE_FILE` (zwykle bez zmian), rozliczenia (`FINANCE_USER_IDS`, `PROTOCOL_ISSUER`, `PROTOCOL_RETURN_EMAIL`, `PROTOCOL_TITLE`; patrz rozdział „Rozliczenia”) oraz, tylko na Railway, `PROXY_TYPE`, `STATE_SEED_B64` i `PORT` (patrz rozdział „Railway”).
Jeśli na serwerze są dwa kanały o tej samej nazwie, bot wybiera ten niewidoczny dla @everyone. Kanał wskazany numerem (`DIGEST_CHANNEL_ID`) to Twoja świadoma decyzja i bot go nie sprawdza.

## Gdy coś nie działa

- **Komend nie ma na serwerze:** zaproszenie bez `applications.commands`. Zaproś bota ponownie tym samym linkiem i sprawdź logi.
- **„Brakuje tagów statusu”:** na forum musi być sześć tagów o dokładnie takich nazwach jak wyżej (wielkość liter nie ma znaczenia).
- **„Bot nie widzi forum zadań”:** bot nie ma roli Redakcja albo forum ma inną nazwę (`FORUM_NAME` lub `FORUM_ID`). Dokładna przyczyna jest w logach.
- **Tablica się nie odświeża:** w logach szukaj „Odświeżanie żywej tablicy nie wyszło”. Najczęstsza przyczyna to brak uprawnień bota do pisania na kanale tablicy; wpisz `/ustaw-tablice` ponownie.
- **Przycisk „Terminy” lub „Dodaj zadanie” nie otwiera okna:** w logach będzie „Używam starego formatu”, jeśli Discord odrzucił nowy format okna. Bot przełącza się wtedy na prostszy
  (bez listy osób w formularzu nowego zadania; osobę przydzielisz potem menu na karcie).
- **„Used disallowed intents” lub „invalid token” w logach:** `MESSAGE_CONTENT=1` bez włączonego Message Content Intent w Developer Portal albo zły token.
  Bot czeka wtedy 10 minut przed zakończeniem, żeby Docker nie logował go w kółko (Discord resetuje token po 1000 logowań na dobę). Popraw `.env` i uruchom `docker compose up -d`.
- **Zmiana statusu kończy się błędem:** bot musi mieć uprawnienie „Zarządzanie wątkami” (jest w linku zaproszenia) oraz widzieć forum.
- **Brak podsumowania rano:** sprawdź w logach „Podsumowanie dnia pominięte” (np. brak uprawnień do pisania na kanale). Błąd konfiguracji bot zgłasza raz i do końca dnia nie ponawia;
  chwilowe błędy Discorda ponawia po 10 minutach, do czterech razy.
- **Rozliczenia: „Rozliczenia są wyłączone”:** brak `FINANCE_USER_IDS` albo twojego numeru na liście. **Szkic nie przyszedł pierwszego dnia roboczego:** sprawdź, czy masz włączone wiadomości prywatne od członków serwera (bot ponawia co pół godziny, a w logach jest „nikt z zarządu nie dostał szkicu”),
  albo zażądaj go ręcznie `/rozliczenia szkic`. W logu nie ma kwot, tylko liczby osób. **Osoba nie dostała protokołu:** ma wyłączone wiadomości prywatne od członków serwera (Discord, Ustawienia, Prywatność i bezpieczeństwo); po zmianie kliknij **Ponów wysyłkę**
  albo prześlij jej PDF ze szkicu sam. **„Dane zmieniły się od czasu szkicu”:** to zabezpieczenie, nic nie zostało wysłane; zatwierdź nowy szkic.
- **Komputer się uśpił:** bot nie działa, gdy komputer śpi lub Docker Desktop jest wyłączony, a tablica stoi w miejscu. Po wybudzeniu bot połączy się sam i odświeży tablicę;
  podsumowanie wyśle, jeśli jeszcze mieści się w oknie 9:00-15:00.
- **Strona się nie uruchamia:** w logach szukaj „PUBLIC_URL” (zły adres: musi być `https://…` bez ścieżki) albo „HTTP_PORT”. Bez `DISCORD_CLIENT_SECRET` strony nie ma, a reszta bota działa.
- **Logowanie w przeglądarce kończy się komunikatem:** „Logowanie nie powiodło się” zwykle oznacza brak `<PUBLIC_URL>/auth/callback` w OAuth2 → Redirects albo zły `DISCORD_CLIENT_SECRET`
  (dokładna przyczyna jest w logach bota). „To konto nie ma dostępu do forum redakcji” to konto spoza serwera lub bez roli Redakcja.
  „Logowanie wygasło albo zostało przerwane” to dłuższa przerwa na ekranie zgody. „Nie wyrażono zgody w Discordzie” to kliknięcie „Anuluj” na ekranie zgody. W obu ostatnich przypadkach zaloguj się jeszcze raz.
- **Przycisk Activity nic nie robi albo pokazuje błąd:** Activities nie są włączone, mapowanie URL jest złe (bez `https://`), aplikacja nie jest zweryfikowana, a serwer ma 25 członków lub więcej,
  albo konto nie jest w zespole aplikacji. Wersja w przeglądarce działa niezależnie od tego.
- **Strona działa na komputerze, ale nie z internetu:** tunel nie wystartował (`docker compose --profile tunnel logs cloudflared`), hostname wskazuje inną usługę niż `kanban:8080` albo komputer śpi.
- **„Sesja wygasła” na stronie:** bot został zrestartowany (sesje są w pamięci). W Activity logowanie powtarza się samo, w przeglądarce trzeba kliknąć logowanie jeszcze raz.
- **Wyciek tokenu:** w Developer Portal zrób Reset Token, wpisz nowy do `.env` i uruchom `docker compose up -d`.

## Ograniczenia

- **Przeciąganie kart jest tylko na stronie** (przeglądarka albo Activity), nie w samych wiadomościach Discorda; te Discord przeciągać nie pozwala. Strona wymaga publicznego adresu HTTPS
  i działającego komputera. Activity bez weryfikacji działa tylko na serwerach poniżej 25 członków, dla zespołu aplikacji i testerów.
- Na stronie nie ma ręcznego ustawiania kolejności w kolumnie: karty są układane automatycznie (pilne na górze, potem według terminu). Samego przeciągania nie obsłużysz klawiaturą;
  zmianę statusu zrobisz wtedy przyciskami w oknie karty.
- Lista osób do przydziału na stronie zawiera osoby, które bot już zna (ktoś z nich kliknął przycisk, zalogował się na stronie albo ma zadanie). Pełną listę daje `MEMBERS_INTENT=1`.
- Tablica odświeża się ze zwłoką około 2 sekund i nie jest wyświetlana „na żywo” w sensie push: zmiany zbierane w tym czasie trafiają do jednej aktualizacji.
  Bot edytuje tylko te wiadomości, które się zmieniły. Raz na 10 minut przechodzi po wszystkich (to odświeża też etykiety „za 2 dni” → „jutro” i wykrywa ręcznie usunięte wiadomości).
- Kolumna na tablicy mieści około 3800 znaków, czyli kilkadziesiąt zadań; reszta jest w liczniku („… i 12 więcej”). Opublikowane pokazują pięć najnowszych postów (według numeru posta, nie daty publikacji). Zadania oddane do redakcji są „po terminie” dopiero po terminie publikacji (jeśli go mają), a opublikowane nigdy (patrz „Dwa terminy”).
- Osoba, termin i priorytet są w pliku stanu bota (patrz wyżej), a nie w Discordzie.
- **Rozliczenia nie są księgowością.** Bot zlicza teksty razy stawka plus premie i wysyła zestawienie do podpisu. Nie wystawia faktur ani rachunków, nie liczy podatków, składek ani brutto/netto, nie śledzi, kto odesłał podpisany protokół,
  i nie zna korekt ujemnych: błąd po wysyłce poprawiasz poza botem albo w kolejnym miesiącu. Teksty liczą się do osoby przypisanej w chwili szkicu, a stawka to ta z chwili szkicu (zmiana stawki w trakcie miesiąca dotyczy wszystkich tekstów z tego miesiąca).
  Starsze karty w postach nie mają przycisku premii za social do czasu najbliższej zmiany w poście albo `/panel`; po zatwierdzeniu protokołu karta pokazuje „zatwierdzona” do następnej zmiany (rozliczenie jej nie odświeża).
  Pierwszy dzień roboczy to poniedziałek-piątek; święta bot pomija (szkic i tak czeka na Twoje zatwierdzenie). Treść PDF to roboczy szablon do sprawdzenia z księgową.
- Gdy osoba przypisana do zadania opuści serwer, zadanie zostaje przypisane do niej (na tablicy zobaczysz nieczytelne oznaczenie). Zwolnij je `/edytuj zwolnij:True` albo przydziel komuś innemu; bot nie śledzi odejść z serwera.
- Termin bez roku (`05.11`) bot rozumie jako najbliższą taką datę w przyszłości. Jeśli wpiszesz datę z przeszłości bez roku, dostaniesz następny rok; bot zawsze pokazuje w odpowiedzi, jaki termin zapisał.
- Przyciski i komendy są dla każdego, kto widzi forum (rola Redakcja). Bot nie rozróżnia osób tylko do odczytu, jeśli na forum są takie uprawnienia.
- Zmiana tagu statusu ręcznie w kliencie Discorda działa i tablica ją uwzględni, ale bot nie pilnuje wtedy zasad (np. kto może ustawić „Do publikacji”).
  Ręczną zmianę tagów końcowych zatrzymuje dopiero zaznaczenie „Moderowany” przy tagu (krok 7).
- Posty bez aktywności Discord archiwizuje po czasie ustawionym na forum (maksymalnie tydzień). Bot widzi także zarchiwizowane, ale tylko 500 najnowszych (5 stron po 100);
  jeśli jest ich więcej, napisze o tym w nagłówku tablicy i w podsumowaniu. Przy zmianie statusu bot odarchiwizowuje post.
- Discord pozwala na 5 tagów w poście. Gdy post ma już 5 tagów tematu, bot nie zmieni statusu i prosi o usunięcie jednego tagu (niczego nie kasuje po cichu).
  Przydział osoby działa wtedy bez automatycznej zmiany statusu.
- **Stan sprawdzenia strony:** testy objęły prawdziwy serwer HTTP bota, prawdziwego discord.js i prawdziwą przeglądarkę (Chromium z emulacją dotyku), a oficjalny SDK Activity sprawdzono
  na atrapie hosta Discorda zbudowanej ze schematów samego SDK. Nic z tego nie zastępuje prawdziwego Discorda: logowanie, mapowanie URL, polityka bezpieczeństwa serwera pośredniczącego Discorda i
  uruchomienie przyciskiem zostały zweryfikowane tylko na atrapach, a dotyk na prawdziwych iPhonie i Androidzie wcale. Obraz Dockera (`Dockerfile`, `docker-compose.yml`) nie został tam, gdzie
  powstawał, zbudowany ani uruchomiony (brak demona Dockera): sprawdziłem składnię pliku compose poleceniem `docker compose config` i odtworzyłem budowę obrazu krok po kroku zwykłym `npm ci` i `node scripts/build.js`.
  Pierwsze uruchomienie traktuj jak test (rozdział „Sprawdzenie”); jeśli `docker compose up -d --build` zgłosi błąd budowy, wklej mi go.
- **Stan sprawdzenia bota:** bot był uruchomiony na prawdziwym Discordzie tylko w wersji z menu statusu i komendami. Karty z przyciskami, formularze, żywa tablica i filtry
  były sprawdzone wyłącznie na atrapie, która odtwarza API Discorda, więc pierwsze uruchomienie traktuj jak test (krok „Pierwszy test”) i zajrzyj do logów.
  Formularze używają nowego typu okna z listą osób; jeśli Discord go nie przyjmie, bot przełącza się na prostszy.

## Testy (opcjonalnie)

```
npm install
npm test
npm run build
```

`npm run build` składa stronę do folderu `public/` (Docker robi to sam przy `docker compose up --build`). Testy w przeglądarce są osobne i opcjonalne
(bez zainstalowanego Playwrighta `npm run test:browser` pomija je i kończy się na zielono, więc sam „zielony” wynik nic nie znaczy, dopóki w podsumowaniu nie widać, że testy się wykonały):

```
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

Testy (Node 22) uruchamiają prawdziwy discord.js przeciwko fałszywemu Discordowi (bramka i REST) i sprawdzają komendy, karty, przyciski, formularze,
uprawnienia, żywą tablicę (tworzenie, edycje różnicowe, odbudowę), filtry, podsumowanie dnia oraz błędy.
Zielone testy dowodzą, że kod zgadza się z atrapą, a nie z prawdziwym Discordem.

`npm audit` zgłasza uwagę do pakietu `zod`, który wchodzi przez SDK Activity. Dotyczy tylko kodu składanego do strony w przeglądarce (nie działa w bocie), a `npm audit --omit=dev`,
czyli to, co trafia do obrazu Dockera, jest czyste.
