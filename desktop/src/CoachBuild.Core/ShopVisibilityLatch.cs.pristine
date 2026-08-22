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
/// see below.</item>
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
/// <para><b>Residual, stated plainly:</b> closing the shop by clicking its own
/// close button, or by walking out of range, produces no key edge and leaves
/// the latch open until the next press. Nothing here can see that, and nothing
/// here pretends to.</para>
///
/// <para>Pure and edge-driven so the whole state machine is testable without a
/// keyboard, a game, or an unlocked workstation.</para>
/// </summary>
public sealed class ShopVisibilityLatch
{
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
    /// </summary>
    public static readonly TimeSpan InsistGap = TimeSpan.FromMilliseconds(600);

    private bool _open;
    private bool _chatOpen;
    private bool _previousShopDown;
    private bool _previousCloseDown;
    private bool _previousChatDown;
    private string _reason = ReasonNotInGame;

    /// <summary>When the current chat belief was last affirmed by a chat edge.</summary>
    private TimeSpan _chatSince;

    /// <summary>Suppressed shop-key edges within the CURRENT belief episode, and when the first landed.</summary>
    private int _suppressedThisBelief;
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
        _suppressedThisBelief = 0;
        _firstSuppressedAt = TimeSpan.Zero;
        Toggles = 0;
        SuppressedByChat = 0;
        ChatOverrides = 0;
        ChatBeliefsExpired = 0;
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
            return Settle(wasOpen, ReasonLeagueNotForeground, chatNote: leftNote);
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
            if (_chatOpen)
            {
                // The player has already had one press swallowed in this
                // episode and has pressed again, slowly enough that it cannot
                // be a repeated letter. Believe the player over the inference.
                if (_suppressedThisBelief >= 1 && observation.At - _firstSuppressedAt >= InsistGap)
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
                    if (_suppressedThisBelief == 0) _firstSuppressedAt = observation.At;
                    _suppressedThisBelief++;
                    suppressedNow = true;
                    reason = ReasonChatSuppressed;
                }
            }

            if (!_chatOpen)
            {
                _open = !_open;
                Toggles++;
                reason = insisted ? ReasonChatOverridden : ReasonShopKey;
            }
        }

        // Once the game is running, League has the foreground and nothing is
        // being pressed, the honest reason is "closed" rather than whichever
        // gate happened to close it last.
        if (!shopEdge && !closeEdge && !_open
            && (reason == ReasonNotInGame || reason == ReasonLeagueNotForeground))
        {
            reason = ReasonIdle;
        }

        return Settle(wasOpen, reason, suppressedNow, chatNote);
    }

    /// <summary>
    /// Starts (or re-affirms) a chat belief and opens a fresh suppression
    /// episode, so insistence counts presses against THIS belief and not
    /// against one three minutes ago.
    /// </summary>
    private string? BelieveChatOpen(TimeSpan at, string note)
    {
        var wasOpen = _chatOpen;
        _chatOpen = true;
        _chatSince = at;
        _suppressedThisBelief = 0;
        _firstSuppressedAt = TimeSpan.Zero;
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
        _suppressedThisBelief = 0;
        _firstSuppressedAt = TimeSpan.Zero;
        return wasOpen ? note : null;
    }

    private ShopLatchState Settle(
        bool wasOpen, string reason, bool suppressedNow = false, string? chatNote = null)
    {
        _reason = reason;
        return new ShopLatchState(_open, reason, _open != wasOpen, suppressedNow, chatNote);
    }
}
