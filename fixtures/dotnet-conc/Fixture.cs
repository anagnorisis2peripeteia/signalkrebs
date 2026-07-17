using System.Threading.Tasks;
// PLANTED DEFECT: unbounded .Result blocks synchronously on an async call (sync-over-async).
public class Fixture {
  Task<int> FetchAsync() => Task.FromResult(1);
  public int Planted() => FetchAsync().Result; // concurrency defect the lane must catch
}
