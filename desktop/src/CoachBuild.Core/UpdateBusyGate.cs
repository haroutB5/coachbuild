namespace CoachBuild.Core;

public sealed class UpdateBusyGate
{
    private readonly CompanionState _state;

    public UpdateBusyGate(CompanionState state) => _state = state;

    public bool IsCompanionBusy => _state.IsCompanionBusy;

    public bool CanApplyUpdate() => !IsCompanionBusy;

    public IDisposable BeginLcuWrite() => _state.BeginLcuWrite();
}

