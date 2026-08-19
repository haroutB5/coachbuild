namespace CoachBuild.Core;

/// <summary>One tick of evidence about whether the in-game shop is open.</summary>
/// <param name="InGame">The live game is running (the same gate the overlay uses).</param>
/// <param name="LeagueForeground">The foreground window belongs to the League game process.</param>
/// <param name="ShopKeyDown">The player's OWN <c>evtOpenShop</c> accelerator is held right now.</param>
/// <param name="CloseKeyDown">The player's OWN <c>evtSysMenu</c> accelerator (Escape) is held right now.</param>
/// <param name="ChatKeyDown">Return/Enter is held right now — the key that opens League's chat input.</param>
public readonly record struct ShopObservation(
    bool InGame,
    bool LeagueForeground,
    bool ShopKeyDown,
    bool CloseKeyDown,
    bool ChatKeyDown = false);

/// <summary>The latch's verdict, plus why it says so.</summary>
/// <param name="SuppressedByChatNow">
/// A shop-key edge was seen on THIS tick and deliberately ignored because chat
/// is believed open. Carried separately from <paramref name="Changed"/> because
/// a suppressed edge changes the verdict by definition NOT AT ALL - so a
/// consumer that only reacts to <paramref name="Changed"/> could never tell
/// "your key was ignored" from "your key was never seen", which are the two
/// reports this distinction exists to separate.
/// </param>
public readonly record struct ShopLatchState(
    bool Open,
    string Reason,
    bool Changed,
    bool SuppressedByChatNow = false);

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
/// typed in chat. The gate is deliberately asymmetric and that asymmetry is the
/// argument for it: believing chat is open when it is not merely SUPPRESSES a
/// toggle — the player presses the key again and it works — whereas believing
/// chat is closed when it is open is exactly the behaviour we already have
/// without the gate. Its worst case is strictly milder than the problem it
/// solves, which is the only reason a second inferred latch is allowed to sit
/// on top of the first.</para>
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
    public const string ReasonIdle = "closed";

    private bool _open;
    private bool _chatOpen;
    private bool _previousShopDown;
    private bool _previousCloseDown;
    private bool _previousChatDown;
    private string _reason = ReasonNotInGame;

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
        Toggles = 0;
        SuppressedByChat = 0;
    }

    public ShopLatchState Observe(ShopObservation observation)
    {
        var wasOpen = _open;

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
            _previousChatDown = observation.ChatKeyDown;
            return Settle(wasOpen, ReasonNotInGame);
        }

        if (!observation.LeagueForeground)
        {
            // Track the raw key state anyway so that returning to League with a
            // key already held is not a rising edge. Without this, alt-tabbing
            // back while resting a finger on the bind would open the latch.
            _previousShopDown = observation.ShopKeyDown;
            _previousCloseDown = observation.CloseKeyDown;
            _previousChatDown = observation.ChatKeyDown;
            _open = false;
            // Whatever was typed elsewhere, League's chat is not focused while
            // League is not the foreground window.
            _chatOpen = false;
            return Settle(wasOpen, ReasonLeagueNotForeground);
        }

        var shopEdge = observation.ShopKeyDown && !_previousShopDown;
        var closeEdge = observation.CloseKeyDown && !_previousCloseDown;
        var chatEdge = observation.ChatKeyDown && !_previousChatDown;
        _previousShopDown = observation.ShopKeyDown;
        _previousCloseDown = observation.CloseKeyDown;
        _previousChatDown = observation.ChatKeyDown;

        var reason = _reason;

        // Enter opens League's chat input, and Enter again sends and closes it.
        if (chatEdge) _chatOpen = !_chatOpen;

        // Escape closes the chat input if it is open, and otherwise closes the
        // shop. It never does both, which is what the game does.
        if (closeEdge)
        {
            if (_chatOpen)
            {
                _chatOpen = false;
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
            if (_chatOpen)
            {
                SuppressedByChat++;
                suppressedNow = true;
                reason = ReasonChatSuppressed;
            }
            else
            {
                _open = !_open;
                Toggles++;
                reason = ReasonShopKey;
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

        return Settle(wasOpen, reason, suppressedNow);
    }

    private ShopLatchState Settle(bool wasOpen, string reason, bool suppressedNow = false)
    {
        _reason = reason;
        return new ShopLatchState(_open, reason, _open != wasOpen, suppressedNow);
    }
}
