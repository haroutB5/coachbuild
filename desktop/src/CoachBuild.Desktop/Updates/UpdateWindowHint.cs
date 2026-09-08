namespace CoachBuild.Desktop.Updates;

/// <summary>
/// Projects a staged update onto the companion window's existing status line.
/// No toast, no focus steal, no new window: one quiet line in the slot the
/// site tabs already use, shown only while that slot is otherwise idle. A
/// site message (import progress/result, popup notice) always wins — the hint
/// never overwrites one, it waits for the slot to go idle again.
/// </summary>
public static class UpdateWindowHint
{
    /// <summary>
    /// The hint text for <paramref name="model"/>, or null when there is
    /// nothing to show. Set exactly when a downloaded release is sitting
    /// behind the open-window gate (<see cref="UpdateStatus.Staged"/>) or the
    /// mid-write gate (<see cref="UpdateStatus.DeferredBusy"/>); every other
    /// status — including the transient <see cref="UpdateStatus.Ready"/> the
    /// service passes through on its way to one of those — clears the slot.
    /// </summary>
    public static string? For(UpdateTrayModel? model)
    {
        if (model is null || string.IsNullOrWhiteSpace(model.Version)) return null;
        return model.Status switch
        {
            UpdateStatus.Staged or UpdateStatus.DeferredBusy =>
                $"Update {model.Version} ready - restart from the tray to apply",
            _ => null,
        };
    }
}
