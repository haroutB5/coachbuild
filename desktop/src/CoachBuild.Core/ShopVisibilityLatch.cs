namespace CoachBuild.Core;

/// <summary>One tick of evidence about whether the in-game shop is open.</summary>
/// <param name="InGame">The live game is running (the same gate the overlay uses).</param>
/// <param name="LeagueForeground">The foreground window belongs to the League game process.</param>
/// <param name="ShopKeyDown">The player's OWN <c>evtOpenShop</c> accelerator is held right now.</param>
/// <param name="CloseKeyDown">The player's OWN <c>evtSysMenu</c> accelerator (Escape) is held right now.</param>
/// <param name="ChatKeyDown">Return/Enter is held right now — the key that opens League's chat input.</param>
/// <param name="ChatAllKeyDown">
/// Shift+Return is held right now — League's ALL-CHAT bind, which also opens the
/// same chat input. It is a separate field rather than a relaxation of the
/// Enter test because the watcher matches modifiers EXACTLY (see
/// <c>ShopKeyWatcher.IsBindDown</c>), so Shift+Enter is invisible to
/// <paramref name="ChatKeyDown"/> by construction — and that invisibility is
/// what stranded a real player for a whole game on 2026-08-19. See the class
/// comment's "How the belief goes wrong".
/// </param>
/// <param name="At">
/// A MONOTONIC reading (the watcher passes a <c>Stopwatch</c>'s elapsed time),
/// never wall-clock. The latch expires a stale chat belief off this value, and
/// an NTP step or a DST change must not be able to expire one — or to postpone
/// one indefinitely.
///
/// <para>Required, not optional-with-a-default, deliberately: an observation
/// axis that a test can supply and production can forget is an axis the tests
/// stop covering. Every construction site names it.</para>
/// </param>
public readonly record struct ShopObservation(
    bool InGame,
    bool LeagueForeground,
    bool ShopKeyDown,
    bool CloseKeyDown,
    bool ChatKeyDown,
    bool ChatAllKeyDown,
    TimeSpan At);

/// <summary>The latch's verdict, plus why it says so.</summary>
/// <param name="SuppressedByChatNow">
/// A shop-key edge was seen on THIS tick and deliberately ignored because chat
/// is believed open. Carried separately from <paramref name="Changed"/> because
/// a suppressed edge changes the verdict by definition NOT AT ALL - so a
/// consumer that only reacts to <paramref name="Changed"/> could never tell
/// "your key was ignored" from "your key was never seen", which are the two
/// reports this distinction exists to separate.
/// </param>
/// <param name="ChatNote">
/// One line, non-null ONLY on a tick where the chat BELIEF itself changed.
///
/// <para>Added after an incident the log could not explain. The belief is the
/// gate that decides whether the shop key counts at all, and until now it moved
/// entirely silently: <c>companion.log</c> recorded four suppressed presses and
/// not one word about when, or why, the watcher had come to believe chat was
/// open. Four log lines saying the same thing cannot discriminate between the
/// several ways the belief can desync, so the next incident would have been as
/// blind as this one.</para>
/// </param>
public readonly record struct ShopLatchState(
    bool Open,
    string Reason,
    bool Changed,
    bool SuppressedByChatNow = false,
    string? ChatNote = null);

/// <summary>
/// Decides whether the shop is believed open, from key edges alone.
///
/// <para><b>Riot exposes no shop state.</b> Neither the Live Client Data API
/// nor the LCU has a "shop is open" field, so every possible answer is
/// inferred. The two candidates were reading the screen and watching the
/// player's own shop key, and the choice between them was settled by
/// measurement, not preference. Re-measured on this machine, 2026-08-19:</para>
/// <list type="bullet">
/// <item>one <c>BitBlt</c> of a <b>single pixel</b> from the screen DC:
/// <b>16.65 ms mean</b> over 300 samples — one whole 60 Hz frame;</item>
/// <item>the same <c>BitBlt</c> at 64x64: <b>16.66 ms</b>. The floor is the
/// compositor sync, not the area. (Full screen is 75.9 ms, so it is not that
/// size never matters — it is that even one pixel already costs a frame.)</item>
/// <item>the six <c>GetAsyncKeyState</c> calls one tick of this watcher makes:
/// <b>0.0023 ms mean</b> over 20,000 samples.</item>
/// </list>
/// <para>That is <b>7,194 : 1</b>. At the 50 ms tick the watcher costs 0.046 ms
/// per second of play (0.005% of one core); a screen probe at the same cadence
/// would cost <b>333 ms per second of play — 33% of one core</b>, blocking on
/// the very compositor the game presents through, in a component whose own perf
/// notes treat 8.9 ms of blocking work every three seconds as waste worth
/// removing. Screen reading was never affordable at any useful cadence.</para>
///
/// <para>The cost was never the deciding argument on its own, though. Riot has
/// published nothing whatsoever about screen capture, OCR or pixel sampling —
/// not a permission and not a prohibition — while its ToS names exactly one
/// prohibited acquisition technique and that technique is READING MEMORY. An
/// argument from silence is not a licence, so the shop state is inferred from
/// the player's own keyboard, which reads no game data at all.</para>
///
/// <para><b>This is a latch, and a latch can drift.</b> The shop key TOGGLES,
/// so this mirrors a toggle — and League can close the shop with no key press
/// at all (clicking the panel's close button, or walking out of range). When
/// that happens the latch is wrong until the next key edge. Four gates bound
/// the damage, and each is a separate test:</para>
/// <list type="number">
/// <item>the game ending forces it closed and forgets every edge;</item>
/// <item>League losing the foreground forces it closed, which also means a key
/// pressed in any other application can never reach the latch;</item>
/// <item>the Escape bind closes it, because Escape closes the shop in game;</item>
/// <item>while League's chat input is believed open, the shop key is ignored —
/// see below. <b>Off unless asked for since 1.0.18</b>; the other three are
/// unconditional.</item>
/// </list>
///
/// <para><b>Why the chat gate exists.</b> The player this was built for toggles
/// their shop with grave/backtick, which is also a key people type. While
/// League's chat input has focus the game does NOT act on the shop bind, so a
/// watcher without this gate opens the latch every time that character is
/// typed in chat.</para>
///
/// <para><b>How the belief goes wrong — and why the old argument for it was
/// false.</b> The gate used to justify itself like this: "believing chat is
/// open when it is not merely SUPPRESSES a toggle — the player presses the key
/// again and it works." <b>That sentence was measured and it is wrong.</b> On
/// 2026-08-19 a player's <c>companion.log</c> recorded, twenty minutes into a
/// game:</para>
/// <code>
/// 21:04:31.38  shop: your shop key was ignored ... (1 so far this game)
/// 21:04:31.69  shop: your shop key was ignored ... (2 so far this game)
/// 21:04:40.20  shop: your shop key was ignored ... (3 so far this game)
/// 21:04:50.69  shop: your shop key was ignored ... (4 so far this game)
/// </code>
/// <para>Four presses, seven minutes of game left, and the numbers never drew
/// once. Pressing again did NOT work, because a stuck belief is not a
/// suppressed toggle — it is a suppressed EVERYTHING, for as long as the belief
/// lasts, and nothing in the old design ever ended it. The real defect was
/// never any single desync; it was that ONE missed edge could strand the player
/// for the rest of the match with no recovery they could discover from inside
/// the game.</para>
///
/// <para>The desyncs themselves are structural, and the belief only has to be
/// wrong an ODD number of times to stick:</para>
/// <list type="bullet">
/// <item><b>Shift+Enter (all-chat) was invisible.</b> The watcher matches
/// modifiers exactly — correctly, because Alt+Enter is League's fullscreen
/// toggle and opens no chat at all — so Shift+Enter never reached this class,
/// while the plain Enter that SENDS the message did. Open unseen, close seen:
/// the belief flips to "open" at the exact moment chat actually closes, and
/// stays there. This is the mechanism that best fits the log above, and
/// <see cref="ShopObservation.ChatAllKeyDown"/> is the fix for it.</item>
/// <item><b>Chat can close without any key edge</b> — the same residual the
/// shop latch itself has. Nothing here can see that.</item>
/// <item><b>An Enter tap can fall between two 50 ms samples.</b> Unlikely for
/// an 80–150 ms press, not impossible while spamming.</item>
/// </list>
///
/// <para><b>So the belief is now self-healing, three ways, and the first two
/// are new.</b> None of them reads the screen, the game's memory, or anything
/// Riot has not already handed us:</para>
/// <list type="number">
/// <item><b>Insistence beats the gate.</b> A SECOND suppressed shop-key edge,
/// at least <see cref="InsistGap"/> after the first in the same episode, clears
/// the belief and is honoured. This is the recovery the old comment merely
/// PROMISED, made real: press it again and it works. The gap requirement is
/// what keeps it safe — a double letter typed in chat ("happy", for a player on
/// League's default <c>P</c> bind) repeats in ~100 ms, whereas a human who
/// thinks the app is broken re-presses hundreds of milliseconds later. In the
/// log above the third press, 8.8 s after the first, would have drawn the
/// numbers.</item>
/// <item><b>A belief goes stale.</b> It expires <see cref="ChatBeliefTimeout"/>
/// after the chat edge that last affirmed it. A message is composed and sent in
/// seconds; a belief older than this is far likelier to be a missed edge than a
/// player still typing. Generous on purpose, because insistence already
/// provides the fast path — this is only the backstop that guarantees a desync
/// cannot outlive a fight.</item>
/// <item><b>Alt-tabbing clears it</b>, as it always did: League's chat is not
/// focused while League is not the foreground window.</item>
/// </list>
///
/// <para><b>The tradeoff, stated plainly.</b> Both new paths can drop the gate
/// while the player really is typing, and the cost of that is the numbers
/// appearing over a shut shop until the next key. That is the mild direction:
/// the badges are inert, click-through decoration, and one more press of the
/// shop key removes them. The direction this replaces is a dead feature for a
/// whole game. The gate keeps doing its one job — the FIRST typed shop
/// character is still swallowed, which is the case it was built for.</para>
///
/// <para><b>Residual, stated plainly, and now BOUNDED:</b> closing the shop by
/// clicking its own close button, or by walking out of range, produces no key
/// edge. Nothing here can see that and nothing here pretends to — but 1.0.18
/// stops it lasting forever. The first field screenshot of this feature
/// working showed the badges drawn correctly over open terrain with the shop
/// shut, so the residual is not theoretical and it is not rare: walking away
/// from the fountain is what every shop visit ends with. An open verdict that
/// nothing has affirmed for <see cref="OpenLatchTimeout"/> is dropped, and says
/// so in the log. The player's own press is still the fast path.</para>
///
/// <para><b>1.0.18: the gate is OFF by default, and this is a decision about
/// one player, not a discovery about the code.</b> A second game, played on
/// 1.0.17 with the self-healing above, swallowed six more presses and honoured
/// none — the log is <c>_evidence/gaming-pc-companion-2026-08-19-1017.log</c>.
/// The player's instruction after reading it was that the shop key must show
/// the numbers EVERY time it is pressed, no gate and no exceptions; they know
/// their shop character can appear in a typed message and they want the press
/// honoured anyway. So <see cref="ChatGateEnabled"/> now has to be asked for.
/// With it off the belief is still tracked — it costs one
/// <c>GetAsyncKeyState</c> and it is what puts "chat gate off" and
/// <see cref="ChatGateBypassed"/> on the honoured-press line, which is the only
/// way a future log can say whether the gate would have been right — but it
/// never swallows anything, and it writes no lines of its own.</para>
///
/// <para>The gate is kept rather than deleted because it is CORRECT for the
/// player it was built for, which is not this one: League's default shop bind
/// is <c>P</c>, a letter that lands in typed words constantly, and for that
/// player an ungated latch pops the overlay mid-sentence. The measurement, the
/// state machine and its tests are the record of that; a bool is four lines and
/// deleting them would make re-enabling a rewrite.</para>
///
/// <para>Pure and edge-driven so the whole state machine is testable without a
/// keyboard, a game, or an unlocked workstation.</para>
/// </summary>
public sealed class ShopVisibilityLatch
{
    private readonly bool _chatGateEnabled;

    /// <param name="chatGateEnabled">
    /// Whether a shop-key edge may be SWALLOWED because League's chat input is
    /// believed to have focus. Required rather than defaulted, deliberately:
    /// the product default is OFF and a test fixture that could quietly supply
    /// ON would leave the shipped configuration uncovered while every suite
    /// stayed green.
    /// </param>
    public ShopVisibilityLatch(bool chatGateEnabled)
    {
        _chatGateEnabled = chatGateEnabled;
    }

    /// <summary>Whether the chat gate may swallow a shop-key edge at all.</summary>
    public bool ChatGateEnabled => _chatGateEnabled;

    public const string ReasonNotInGame = "not-in-game";
    public const string ReasonLeagueNotForeground = "league-not-foreground";
    public const string ReasonShopKey = "shop-key";
    public const string ReasonCloseKey = "close-key";
    public const string ReasonChatSuppressed = "shop-key-ignored-while-chatting";

    /// <summary>
    /// A shop-key edge that was honoured BECAUSE the player had already had one
    /// swallowed and pressed again. Distinct from <see cref="ReasonShopKey"/>
    /// so the log can say the gate was overridden rather than never engaged.
    /// </summary>
    public const string ReasonChatOverridden = "shop-key-insisted-past-chat";

    /// <summary>
    /// A shop-key edge honoured while chat WAS believed open, because the gate
    /// is switched off. It is a distinct reason so that a log can answer, per
    /// press, the question the 1.0.17 incident could not: would the old gate
    /// have swallowed this one? Every occurrence is a press the player wanted
    /// and 1.0.17 would have eaten.
    /// </summary>
    public const string ReasonChatGateOff = "shop-key-honoured-chat-gate-off";

    /// <summary>
    /// The latch dropped an open verdict that nothing had affirmed for
    /// <see cref="OpenLatchTimeout"/>. Its own reason so a log can tell a
    /// backstop firing from a player pressing their key.
    /// </summary>
    public const string ReasonOpenTimedOut = "shop-latch-timed-out";

    public const string ReasonIdle = "closed";

    /// <summary>
    /// How long a chat belief survives without a chat-key edge to affirm it.
    ///
    /// <para>30 s. Long enough that nobody is interrupted mid-message — a
    /// League message is typed and sent in a handful of seconds — and short
    /// enough that a desync cannot outlive a single fight. It is a BACKSTOP,
    /// not the primary recovery: <see cref="InsistGap"/> is what gets a player
    /// their numbers back on the next press.</para>
    /// </summary>
    public static readonly TimeSpan ChatBeliefTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long after the first swallowed shop-key edge a second one counts as
    /// the player INSISTING rather than as typing.
    ///
    /// <para>600 ms. A repeated letter inside a typed word lands ~100 ms apart
    /// (and needs the shop bind to be a letter at all — the reference player's
    /// is grave). A person who believes the app is ignoring them re-presses far
    /// slower than that. The real log's four presses were 0.31 s, 8.8 s and
    /// 19.3 s after the first, so the second qualifies nothing and the third
    /// recovers — which is the intended shape: a fumbled double-tap does not
    /// override the gate, a deliberate second attempt does.</para>
    ///
    /// <para><b>1.0.18: measured against the SECOND log, insistence is counted
    /// per GAME and not per belief.</b> In 1.0.17 the episode was zeroed by
    /// every belief transition, because <c>BelieveChatOpen</c> and
    /// <c>ForgetChatBelief</c> both cleared the counter. That made the override
    /// unreachable for any player whose chat opens and closes between presses,
    /// which is every player who actually uses chat: in the 1.0.17 log the
    /// belief flipped roughly fifteen times in eight minutes and five of the
    /// six suppressed presses were alone inside their belief episode, so
    /// "press it again" had nothing to count against. The counter now survives
    /// belief transitions and is cleared only by an HONOURED press and by the
    /// end of the game — the two events that mean the player got what they
    /// asked for.</para>
    /// </summary>
    public static readonly TimeSpan InsistGap = TimeSpan.FromMilliseconds(600);

    /// <summary>
    /// How long the latch may claim the shop is open with nothing affirming it.
    ///
    /// <para><b>This bounds the residual the class comment has always admitted
    /// to, and 1.0.18 is the first release in which that residual is VISIBLE.</b>
    /// A screenshot from the player's gaming PC shows the badges drawing
    /// correctly — four pills, right colours, right styling, on League's own
    /// window — over open terrain with the shop shut. League closes the shop
    /// when you click its close button and when you walk out of range, and
    /// NEITHER produces a key edge, so the latch stays open and the pills stay
    /// up. Walking away from the fountain is not an edge case; it is what
    /// happens every single time somebody shops.</para>
    ///
    /// <para>90 s, and deliberately generous. It is a BACKSTOP against pills
    /// stranded over gameplay for the rest of a match, not an attempt to track
    /// the shop: a real visit is seconds, and the cost of firing too early is
    /// one press to bring the numbers back, against a whole match of clutter if
    /// it never fires at all. It is logged with its own reason, so the next log
    /// says whether it ever fired while the player was really shopping — which
    /// is the evidence needed to tune it, and the reason it is not tuned
    /// tighter now.</para>
    /// </summary>
    public static readonly TimeSpan OpenLatchTimeout = TimeSpan.FromSeconds(90);

    private bool _open;
    private bool _chatOpen;
    private bool _previousShopDown;
    private bool _previousCloseDown;
    private bool _previousChatDown;
    private string _reason = ReasonNotInGame;

    /// <summary>When the current chat belief was last affirmed by a chat edge.</summary>
    private TimeSpan _chatSince;

    /// <summary>When the shop-key edge that opened the latch landed.</summary>
    private TimeSpan _openSince;

    /// <summary>
    /// Suppressed shop-key edges since the last HONOURED one, and when the
    /// first of them landed. Deliberately NOT per belief episode — see
    /// <see cref="InsistGap"/>.
    /// </summary>
    private int _suppressedSincePress;
    private TimeSpan _firstSuppressedAt;

    public bool IsOpen => _open;

    /// <summary>Whether League's chat input is believed to have focus.</summary>
    public bool IsChatOpen => _chatOpen;

    public string Reason => _reason;

    /// <summary>How many times a shop-key edge has flipped the latch this game.</summary>
    public int Toggles { get; private set; }

    /// <summary>
    /// How many shop-key edges were swallowed by the chat gate this game. On
    /// the log line this is the difference between "the watcher never saw your
    /// key" and "it saw it and deliberately ignored it", which are the two
    /// reports a player would otherwise describe with the same sentence.
    /// </summary>
    public int SuppressedByChat { get; private set; }

    /// <summary>
    /// How many times the player pressed past a stuck chat belief this game.
    /// A non-zero count in a log is the signature of a desync that the
    /// self-healing caught — it names the bug without the player noticing it.
    /// </summary>
    public int ChatOverrides { get; private set; }

    /// <summary>
    /// How many times a chat belief was dropped for going stale this game.
    /// Same purpose as <see cref="ChatOverrides"/>: the counters are how a
    /// future incident is diagnosed instead of guessed at.
    /// </summary>
    public int ChatBeliefsExpired { get; private set; }

    /// <summary>
    /// How many shop-key edges were honoured this game while chat WAS believed
    /// open, because the gate is off. This is the number that says whether the
    /// gate would have been earning its keep: a game full of these where the
    /// player also reports the numbers behaving is a game in which the gate
    /// would have been wrong every time.
    /// </summary>
    public int ChatGateBypassed { get; private set; }

    /// <summary>
    /// How many times an open verdict was dropped for going stale this game.
    /// Every one is a shop that closed without a key edge — or, if the player
    /// says the numbers vanished while they were still shopping,
    /// <see cref="OpenLatchTimeout"/> being too short. The counter is what
    /// tells those two apart.
    /// </summary>
    public int LatchesTimedOut { get; private set; }

    /// <summary>
    /// Forgets everything. Called when a game ends so the next game cannot
    /// inherit a latch — the same class of defect as the 1.0.11 highlight that
    /// outlived its match.
    /// </summary>
    public void Reset()
    {
        _open = false;
        _chatOpen = false;
        _previousShopDown = false;
        _previousCloseDown = false;
        _previousChatDown = false;
        _reason = ReasonNotInGame;
        _chatSince = TimeSpan.Zero;
        _openSince = TimeSpan.Zero;
        _suppressedSincePress = 0;
        _firstSuppressedAt = TimeSpan.Zero;
        Toggles = 0;
        LatchesTimedOut = 0;
        SuppressedByChat = 0;
        ChatOverrides = 0;
        ChatBeliefsExpired = 0;
        ChatGateBypassed = 0;
    }

    public ShopLatchState Observe(ShopObservation observation)
    {
        var wasOpen = _open;

        // ONE logical key. Enter and Shift+Enter are the same physical key with
        // the same effect on the chat input, so the edge is taken on "either is
        // down". Edging them separately would invent a press every time the
        // player modulated Shift with Enter already held.
        var chatDown = observation.ChatKeyDown || observation.ChatAllKeyDown;

        if (!observation.InGame)
        {
            // Forget the latch and the counters - they belong to the game that
            // produced them - but KEEP TRACKING the raw key state.
            //
            // Zeroing the previous-key fields here was a bug, and precisely the
            // one the comment claimed to prevent: it is what makes a key held
            // across the start of a game read as a fresh press on the first
            // in-game tick. "Held across the boundary is not a press" is a
            // statement about edge detection, and edge detection needs the
            // previous sample, not the absence of one.
            Reset();
            _previousShopDown = observation.ShopKeyDown;
            _previousCloseDown = observation.CloseKeyDown;
            _previousChatDown = chatDown;
            return Settle(wasOpen, ReasonNotInGame);
        }

        if (!observation.LeagueForeground)
        {
            // Track the raw key state anyway so that returning to League with a
            // key already held is not a rising edge. Without this, alt-tabbing
            // back while resting a finger on the bind would open the latch.
            _previousShopDown = observation.ShopKeyDown;
            _previousCloseDown = observation.CloseKeyDown;
            _previousChatDown = chatDown;
            _open = false;
            // Whatever was typed elsewhere, League's chat is not focused while
            // League is not the foreground window.
            var leftNote = ForgetChatBelief("chat: belief cleared (League is not the foreground window)");
            return Settle(wasOpen, ReasonLeagueNotForeground, chatNote: GateNote(leftNote));
        }

        var shopEdge = observation.ShopKeyDown && !_previousShopDown;
        var closeEdge = observation.CloseKeyDown && !_previousCloseDown;
        var chatEdge = chatDown && !_previousChatDown;
        _previousShopDown = observation.ShopKeyDown;
        _previousCloseDown = observation.CloseKeyDown;
        _previousChatDown = chatDown;

        var reason = _reason;
        string? chatNote = null;

        if (chatEdge)
        {
            if (observation.ChatAllKeyDown)
            {
                // Shift+Enter OPENS all-chat. It never closes the input - the
                // send is a plain Enter - so this SETS the belief rather than
                // toggling it, and pressing it while already typing (which
                // switches channel in game) correctly leaves it open.
                chatNote = BelieveChatOpen(observation.At, "chat: believed open (Shift+Enter, all chat)");
            }
            else if (_chatOpen)
            {
                chatNote = ForgetChatBelief("chat: believed closed (Enter sent or dismissed the message)");
            }
            else
            {
                chatNote = BelieveChatOpen(observation.At, "chat: believed open (Enter)");
            }
        }

        // Staleness is judged AFTER the edges above, so a fresh Enter always
        // re-arms the belief rather than racing the expiry.
        if (_chatOpen && observation.At - _chatSince >= ChatBeliefTimeout)
        {
            ChatBeliefsExpired++;
            chatNote = ForgetChatBelief(
                $"chat: belief dropped after {ChatBeliefTimeout.TotalSeconds:0}s with no Enter"
                + " - assuming you are not typing (your shop key works again)")
                ?? chatNote;
        }

        // Escape closes the chat input if it is open, and otherwise closes the
        // shop. It never does both, which is what the game does.
        if (closeEdge)
        {
            if (_chatOpen)
            {
                chatNote = ForgetChatBelief("chat: believed closed (Esc)") ?? chatNote;
            }
            else if (_open)
            {
                _open = false;
                reason = ReasonCloseKey;
            }
        }

        var suppressedNow = false;
        if (shopEdge)
        {
            var insisted = false;
            var bypassed = false;
            if (_chatOpen && !_chatGateEnabled)
            {
                // The gate is off, so the belief is an observation and not a
                // veto. Counted, because this is the only per-press evidence
                // that says whether the gate would have been right.
                bypassed = true;
                ChatGateBypassed++;
            }
            else if (_chatOpen)
            {
                // The player has already had one press swallowed since their
                // last honoured one and has pressed again, slowly enough that
                // it cannot be a repeated letter. Believe the player over the
                // inference.
                if (_suppressedSincePress >= 1 && observation.At - _firstSuppressedAt >= InsistGap)
                {
                    insisted = true;
                    ChatOverrides++;
                    chatNote = ForgetChatBelief(
                        "chat: belief overridden - you pressed your shop key again,"
                        + " so chat cannot have focus (your key works from here)")
                        ?? chatNote;
                }
                else
                {
                    SuppressedByChat++;
                    if (_suppressedSincePress == 0) _firstSuppressedAt = observation.At;
                    _suppressedSincePress++;
                    suppressedNow = true;
                    reason = ReasonChatSuppressed;
                }
            }

            if (!suppressedNow)
            {
                _open = !_open;
                _openSince = observation.At;
                Toggles++;

                // An honoured press is the event that means the player got what
                // they asked for, so it - and NOT the next belief transition -
                // is what ends an insistence run. See InsistGap.
                _suppressedSincePress = 0;
                _firstSuppressedAt = TimeSpan.Zero;

                reason = insisted ? ReasonChatOverridden
                    : bypassed ? ReasonChatGateOff
                    : ReasonShopKey;
            }
        }

        // Judged AFTER the edges, exactly like the chat belief above, so a fresh
        // press always re-arms the latch rather than racing the expiry. This is
        // the only thing standing between "League closed the shop without a key
        // edge" and pills drawn over open terrain for the rest of the match -
        // see OpenLatchTimeout.
        if (_open && !shopEdge && observation.At - _openSince >= OpenLatchTimeout)
        {
            _open = false;
            LatchesTimedOut++;
            reason = ReasonOpenTimedOut;
        }

        // Once the game is running, League has the foreground and nothing is
        // being pressed, the honest reason is "closed" rather than whichever
        // gate happened to close it last.
        if (!shopEdge && !closeEdge && !_open
            && (reason == ReasonNotInGame || reason == ReasonLeagueNotForeground))
        {
            reason = ReasonIdle;
        }

        return Settle(wasOpen, reason, suppressedNow, GateNote(chatNote));
    }

    /// <summary>
    /// The belief's own log lines exist to diagnose the GATE. With the gate off
    /// they are ~50 lines a game about a decision that is no longer being made,
    /// in a file that is trimmed at 200 KB, so they are dropped — the fact the
    /// next incident needs, "was chat believed open when this press landed",
    /// rides on the honoured-press line instead (<see cref="ReasonChatGateOff"/>).
    /// </summary>
    private string? GateNote(string? note) => _chatGateEnabled ? note : null;

    /// <summary>Starts (or re-affirms) a chat belief.</summary>
    private string? BelieveChatOpen(TimeSpan at, string note)
    {
        var wasOpen = _chatOpen;
        _chatOpen = true;
        _chatSince = at;
        return wasOpen ? null : note;
    }

    /// <summary>
    /// Drops the belief. Returns the note ONLY when something actually changed,
    /// so the not-foreground branch cannot log the same line every 50 ms.
    /// </summary>
    private string? ForgetChatBelief(string note)
    {
        var wasOpen = _chatOpen;
        _chatOpen = false;
        _chatSince = TimeSpan.Zero;
        return wasOpen ? note : null;
    }

    private ShopLatchState Settle(
        bool wasOpen, string reason, bool suppressedNow = false, string? chatNote = null)
    {
        _reason = reason;
        return new ShopLatchState(_open, reason, _open != wasOpen, suppressedNow, chatNote);
    }
}
