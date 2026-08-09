namespace CoachBuild.Core;

/// <summary>
/// The lane selected for a skill-order result. A null lane means that all
/// fallback lanes returned no usable recommendation.
/// </summary>
public sealed record SkillOrderSelection(
    string? Lane,
    bool IsLaneAuto,
    SkillOrderResult Result);

/// <summary>
/// Mirrors overlay-host/js/skillOrderData.js's three-tier lane resolution:
/// manual override, mapped Live Client Data position, then the highest-sample
/// result across all five lanes when the position is unresolved.
/// </summary>
public static class SkillOrderLaneResolver
{
    public static IReadOnlyList<string> Lanes { get; } =
        new[] { "TOP", "JUNGLE", "MID", "BOT", "SUPPORT" };

    public static async Task<SkillOrderSelection> ResolveAsync(
        ISkillOrderProvider provider,
        int championId,
        string? laneOverride,
        string? detectedPosition,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(provider);

        var overrideLane = NormalizeLane(laneOverride);
        if (overrideLane is not null)
        {
            var result = await GetSafelyAsync(provider, championId, overrideLane, cancellationToken)
                .ConfigureAwait(false);
            return new SkillOrderSelection(overrideLane, IsLaneAuto: false, result);
        }

        var detectedLane = MapPositionToLane(detectedPosition);
        if (detectedLane is not null)
        {
            var result = await GetSafelyAsync(provider, championId, detectedLane, cancellationToken)
                .ConfigureAwait(false);
            return new SkillOrderSelection(detectedLane, IsLaneAuto: true, result);
        }

        // This is intentionally Promise.all-equivalent: NONE/unresolved
        // positions need every lane's sample size before choosing a claim.
        var requests = Lanes
            .Select(async lane =>
            {
                var result = await GetSafelyAsync(provider, championId, lane, cancellationToken)
                    .ConfigureAwait(false);
                return (Lane: lane, Result: result);
            })
            .ToArray();
        var fallback = await Task.WhenAll(requests).ConfigureAwait(false);

        var best = -1;
        var bestSampleSize = int.MinValue;
        for (var index = 0; index < fallback.Length; index++)
        {
            var candidate = fallback[index].Result;
            if (candidate.Status != SkillOrderStatus.Ok) continue;

            // Strict > preserves Lanes' fixed order as the deterministic tie
            // breaker, just like the web overlay's resolver.
            if (candidate.SampleSize > bestSampleSize)
            {
                best = index;
                bestSampleSize = candidate.SampleSize;
            }
        }

        if (best >= 0)
        {
            return new SkillOrderSelection(
                fallback[best].Lane,
                IsLaneAuto: true,
                fallback[best].Result);
        }

        // Preserve the most useful failure distinction for the overlay even
        // though no lane can honestly be attached to an empty result.
        var failure = fallback.Any(static item => item.Result.Status == SkillOrderStatus.NoData)
            ? SkillOrderStatus.NoData
            : SkillOrderStatus.Error;
        return new SkillOrderSelection(
            Lane: null,
            IsLaneAuto: true,
            Result: failure == SkillOrderStatus.NoData
                ? new SkillOrderResult(SkillOrderStatus.NoData, OverlaySkillOrder.Empty, championId)
                : new SkillOrderResult(SkillOrderStatus.Error, OverlaySkillOrder.Empty, championId));
    }

    public static string? NormalizeLane(string? lane)
    {
        if (string.IsNullOrWhiteSpace(lane)) return null;
        return lane.Trim().ToUpperInvariant() switch
        {
            "TOP" => "TOP",
            "JUNGLE" => "JUNGLE",
            "MID" or "MIDDLE" => "MID",
            "BOT" or "BOTTOM" => "BOT",
            "SUPPORT" or "UTILITY" => "SUPPORT",
            _ => null,
        };
    }

    public static string? MapPositionToLane(string? position)
    {
        if (string.IsNullOrWhiteSpace(position)) return null;
        return position.Trim().ToUpperInvariant() switch
        {
            "TOP" => "TOP",
            "JUNGLE" => "JUNGLE",
            "MIDDLE" => "MID",
            "BOTTOM" => "BOT",
            "UTILITY" => "SUPPORT",
            _ => null,
        };
    }

    private static async Task<SkillOrderResult> GetSafelyAsync(
        ISkillOrderProvider provider,
        int championId,
        string lane,
        CancellationToken cancellationToken)
    {
        try
        {
            return await provider.GetSkillOrderAsync(championId, lane, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return new SkillOrderResult(
                SkillOrderStatus.Error,
                OverlaySkillOrder.Empty,
                championId);
        }
    }
}
