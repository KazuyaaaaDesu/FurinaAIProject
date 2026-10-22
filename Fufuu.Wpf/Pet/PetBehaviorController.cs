namespace Fufuu.Wpf.Pet;

/// <summary>Shared behavior state machine inspired by VPet's separation of controller and graphics.</summary>
public enum PetBehavior { Idle, Walking, Talking, Greeting, Reacting, Interacting, Paused }
public enum MotionCategory { Idle, Locomotion, Greeting, Speech, Reaction, Interaction, Pose }
public enum MotionReturnBehavior { Previous, Idle }

public sealed record MotionDefinition(
    string Id,
    string Label,
    string Source,
    bool Loop,
    MotionCategory Category,
    int Priority,
    MotionReturnBehavior ReturnBehavior = MotionReturnBehavior.Previous);

public sealed class PetBehaviorController
{
    private sealed record TemporaryMotion(PetBehavior Behavior, int Priority, MotionReturnBehavior ReturnBehavior, long Token);
    private PetBehavior _baseBehavior = PetBehavior.Idle;
    private TemporaryMotion? _temporary;
    private long _nextToken = 1;
    private bool _paused;

    public event Action<PetBehavior>? BehaviorChanged;
    public PetBehavior Current => _paused ? PetBehavior.Paused : _temporary?.Behavior ?? _baseBehavior;
    public PetBehavior Base => _baseBehavior;
    public bool IsPaused => _paused;

    public void SetPaused(bool paused)
    {
        if (_paused == paused) return;
        _paused = paused;
        RaiseChanged();
    }

    public void SetBase(PetBehavior behavior)
    {
        if (behavior is not (PetBehavior.Idle or PetBehavior.Walking or PetBehavior.Talking))
            throw new ArgumentOutOfRangeException(nameof(behavior), "Base behavior must be idle, walking, or talking.");
        _baseBehavior = behavior;
        _temporary = null;
        RaiseChanged();
    }

    public long? BeginMotion(MotionDefinition motion)
    {
        ArgumentNullException.ThrowIfNull(motion);
        var behavior = ToBehavior(motion.Category);
        if (behavior is PetBehavior.Idle or PetBehavior.Walking or PetBehavior.Talking)
        {
            SetBase(behavior);
            return null;
        }
        if (_temporary is not null && _temporary.Priority > motion.Priority) return null;
        var token = _nextToken++;
        _temporary = new TemporaryMotion(behavior, motion.Priority, motion.ReturnBehavior, token);
        RaiseChanged();
        return token;
    }

    public long? BeginReaction(int priority = 35)
    {
        if (_temporary is not null && _temporary.Priority > priority) return null;
        var token = _nextToken++;
        _temporary = new TemporaryMotion(PetBehavior.Reacting, priority, MotionReturnBehavior.Previous, token);
        RaiseChanged();
        return token;
    }

    public void FinishTemporary(long token)
    {
        if (_temporary?.Token != token) return; // Ignore stale animation-completion events.
        if (_temporary.ReturnBehavior == MotionReturnBehavior.Idle) _baseBehavior = PetBehavior.Idle;
        _temporary = null;
        RaiseChanged();
    }

    public void CancelTemporary()
    {
        if (_temporary is null) return;
        _temporary = null;
        RaiseChanged();
    }

    public bool Accepts(MotionDefinition motion) =>
        ToBehavior(motion.Category) is PetBehavior.Idle or PetBehavior.Walking or PetBehavior.Talking ||
        _temporary is null || _temporary.Priority <= motion.Priority;

    private static PetBehavior ToBehavior(MotionCategory category) => category switch
    {
        MotionCategory.Idle => PetBehavior.Idle,
        MotionCategory.Locomotion => PetBehavior.Walking,
        MotionCategory.Greeting => PetBehavior.Greeting,
        MotionCategory.Speech => PetBehavior.Talking,
        MotionCategory.Reaction => PetBehavior.Reacting,
        MotionCategory.Interaction or MotionCategory.Pose => PetBehavior.Interacting,
        _ => PetBehavior.Idle
    };

    private void RaiseChanged() => BehaviorChanged?.Invoke(Current);
}
