using System.Threading;
using Xunit;

// Planted-defect fixture for the dotnet-conc DYNAMIC hang probe (#1).
// A non-reentrant SemaphoreSlim(1,1) acquired twice on one thread deadlocks deterministically:
// the second Wait() blocks forever. `dotnet test --blame-hang` must name this test as the hang.
public class DeadlockTest
{
    [Fact]
    public void SelfDeadlocksOnSemaphore()
    {
        var s = new SemaphoreSlim(1, 1);
        s.Wait();
        s.Wait();
    }
}
